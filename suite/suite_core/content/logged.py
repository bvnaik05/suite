"""What a document in a log gives Drive's callbacks, the same for every app: composition calls these around
the app's own callbacks, which keep only the app's row."""

import base64
import gzip
import json
from contextlib import contextmanager

import frappe
import pycrdt
from frappe import _

from suite.suite_core.content import (
    capacity,
    compaction,
    copies,
    jobs,
    live,
    log,
    scheduling,
    tables,
    updates,
)
from suite.suite_core.content.app_row import forget_cached, locked_app_row, write_copy
from suite.suite_core.content.backfill import backfill_clocks
from suite.suite_core.content.checkpoints import replace_start
from suite.suite_core.content.editors import editors, node_hooks, spec_of
from suite.suite_core.content.snapshot import Snapshot, read

# The update format of every state the layer keeps
CODEC = "yjs1"


class NotReady(Exception):
    """The document's log can't answer now; what stopped it is the cause."""


class UnreadableBody(frappe.ValidationError):
    """A state the app's media functions refused to read."""


def version_record(app: str, snapshot: Snapshot, state: bytes) -> dict:
    """`state` as an `{app}-document/2` version; `html` stays null."""
    compressed = gzip.compress(state)
    encoded_state = base64.b64encode(compressed).decode("ascii")
    return {
        "schema": f"{app}-document/2",
        "codec": CODEC,
        "lineage": snapshot.lineage,
        "through_rev": snapshot.head_rev,
        "chain": snapshot.head_chain.hex(),
        "state": encoded_state,
        "html": None,
    }


def record_prefix(app: str) -> bytes:
    """The bytes every version `version` answers for `app` starts with."""
    schema_only = json.dumps({"schema": f"{app}-document/2"})
    return schema_only[:-1].encode("utf-8")


def ensure_tables() -> None:
    """Make every app's tables, and give the documents in them their clocks; on install and migrate."""
    for spec in editors().values():
        tables.ensure_tables(spec.app)
        backfill_clocks(spec.app, node_hooks().owner)


def start(app: str, node: str) -> None:
    """Make a new document collaborative from its first edit, while collaboration is on."""
    if log.enabled(app):
        log.create(app, node)


def copy(app: str, source_node: str, node: str) -> None:
    """Start `node`'s log from `source_node`'s state now, under a new lineage, when the source is in a log."""
    try:
        source_checkpoint = live_checkpoint(app, source_node)
    except (log.ChainBroken, compaction.CompactionFailed) as unready:
        raise NotReady() from unready

    if source_checkpoint is None:
        return

    log_read, state = source_checkpoint
    doc_id = log.create(app, node)
    replace_start(app, doc_id, state, log_read.schema)


def html(app: str, node: str) -> str | None:
    """The readable copy of `node`'s log, or None when it has none; `NotReady` while no copy covers its head."""
    doc = log.find(app, node)
    if not doc:
        return None

    readable_copy = copies.readable_copy(app, doc.id)
    if readable_copy is None:
        raise NotReady()

    return readable_copy


def version(app: str, node: str) -> bytes | None:
    """`node`'s log now as a version, with the pictures it shows, or None when it has none."""
    try:
        checkpoint = live_checkpoint(app, node)
    except (log.ChainBroken, compaction.CompactionFailed) as unready:
        raise NotReady() from unready

    if checkpoint is None:
        return None

    snapshot, state = checkpoint
    record = version_record(app, snapshot, state)
    media = spec_of(app).media
    if media is not None:
        with readable_state():
            record["media"] = sorted(media.node_ids(state))

    return json.dumps(record).encode("utf-8")


def media_ids(app: str, node: str) -> set[str]:
    """The pictures `node`'s log names now; a log that can't be read raises, and Drive's sweep skips it."""
    media = spec_of(app).media
    if media is None:
        return set()

    with readable_state():
        state = live_state(app, node)
        if state is None:
            return set()

        return set(media.node_ids(state.get_update()))


def remap(app: str, node: str, mapping: dict[str, str]) -> bool:
    """Point a copied log and its readable copy at Drive's new pictures, row locked first; False if none."""
    doc = log.find(app, node)
    if not doc:
        return False

    spec = spec_of(app)
    if spec.media is None:
        return True

    with readable_state():
        rewrite = spec.media.value_rewriter(mapping)

    def guarded_rewrite(value: str) -> str:
        with readable_state():
            return rewrite(value)

    html_copy = spec.readable_copy
    if html_copy is not None:
        app_row = locked_app_row(app, doc.id, html_copy)
        if app_row is not None:
            write_copy(app, app_row.name, guarded_rewrite(app_row.written or ""), html_copy)
            forget_cached(app, app_row.name)

    try:
        remap_log(app, node, guarded_rewrite)
    except (ValueError, log.ChainBroken, compaction.CompactionFailed) as refused:
        raise NotReady() from refused

    return True


def purge(app: str, node: str) -> None:
    """Mark `node`'s log purged in Drive's transaction, before the app deletes its row; a job deletes the
    log's rows once that commits."""
    doc_id = log.mark_purged(app, node)
    if doc_id:
        scheduling.enqueue(
            jobs.DELETE_PURGED,
            f"suite-collab-purge-{app}-{doc_id}",
            app=app,
            doc_id=doc_id,
            enqueue_after_commit=True,
        )


def threads_changed(app: str, node: str) -> None:
    """Tell the document's open tabs to read its comment threads again."""
    doc = log.find(app, node)
    if doc:
        live.publish_control(app, doc.id, doc.lineage, kind="threads")


def live_state(app: str, node: str) -> pycrdt.Doc | None:
    """The document as its log stands now, read in the caller's transaction; None when the node has no log.

    Read whether collaboration is on or not, so the media sweep keeps what a log names.
    """
    doc = log.find(app, node)
    log_read = read(app, doc.id, own_snapshot=False) if doc else None
    if log_read is None:
        return None

    checkpoint_part = [log_read.checkpoint] if log_read.checkpoint else []
    row_parts = log_read.payloads()
    parts = checkpoint_part + row_parts
    return compaction.load_doc(parts)


def live_checkpoint(app: str, node: str) -> tuple[Snapshot, bytes] | None:
    """The document's read and its state now, or None when the node has no log.

    Read whether collaboration is on or not. The state is compacted with pycrdt in
    the request from the body, never a fallback, and only an integrated result is
    answered. A state or tail larger than a compaction job would take is refused.
    """
    doc = log.find(app, node)
    log_read = read(app, doc.id, integrated=True, own_snapshot=False) if doc else None
    if log_read is None:
        return None

    rows = log_read.payloads()
    if not rows:
        return log_read, log_read.checkpoint or pycrdt.Doc().get_update()

    # pycrdt cannot be interrupted, so a web worker only takes on what a compaction job would
    total_bytes = len(log_read.checkpoint or b"") + sum(len(row) for row in rows)
    too_big = total_bytes > capacity.STATE_MAX
    too_many_rows = len(rows) > scheduling.TAIL_ROWS
    if too_big or too_many_rows:
        raise compaction.CompactionFailed("too_large")

    part_map = spec_of(app).part_map
    compacted = compaction.compact(log_read.checkpoint, rows, part_map)
    if not compacted.integrated:
        raise compaction.CompactionFailed("fallback")

    return log_read, compacted.state


def remap_log(app: str, node: str, rewrite) -> None:
    """Rewrite the values a copied log starts from, in place: no struct, row or session is added.

    The result must hold the same structs, read as the copy with `rewrite` applied to every
    attribute, mark and embed value, and give nothing more to rewrite.
    """
    doc = log.find(app, node)
    if not doc:
        return

    log_read = read(app, doc.id, own_snapshot=False)
    if log_read is None:
        return

    part_map = spec_of(app).part_map
    state = log_read.checkpoint
    # `copy` starts every copied log from a body
    assert state is not None

    remapped = updates.rewrite_values(state, rewrite)
    if remapped == state:
        return

    original_doc = compaction.load_doc([state])
    remapped_doc = compaction.load_doc([remapped])
    if (
        compaction.vector_and_deletes(remapped_doc) != compaction.vector_and_deletes(original_doc)
        or compaction.content_json(remapped_doc, part_map)
        != compaction.content_json(original_doc, part_map, rewrite)
        or updates.rewrite_values(remapped, rewrite) != remapped
    ):
        raise compaction.CompactionFailed("remap_mismatch")

    replace_start(app, doc.id, remapped, log_read.schema)


@contextmanager
def readable_state():
    """Raise anything the app's media functions raise as `UnreadableBody`.

    pycrdt is a Rust extension, and a state it cannot read raises
    `pyo3_runtime.PanicException`. That derives from `BaseException`, so left
    alone it passes every `except Exception` up to the request, including the
    rollback that closes Drive's savepoint.
    """
    try:
        yield
    except (KeyboardInterrupt, SystemExit, UnreadableBody):
        raise
    except BaseException as unreadable:
        raise UnreadableBody(_("This document body cannot be read")) from unreadable
