"""Trimming: delete the edit rows the app row's checked body holds, once they are past the evidence window.

The base is the body at `body_rev`, never a fallback. A row stays while it is
under a day old and among the newest `max(4 MiB, 2 * state)` bytes the body
covers, so a tab resending a push still finds it. Before anything is deleted,
pycrdt must find that the body holds every row, and so must the product's Node
kernel where the host has Node; otherwise the rows stay and admins are alerted.
The row at `body_rev` always stays, so the body's chain is checked against it.

The hourly run keeps a cursor, so a run killed or out of time resumes where it
stopped. Each check takes one of the bench's compaction places.
"""

import hashlib
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import frappe
from frappe.utils import now_datetime

from suite.suite_core.content import admission, compaction, db, kernel
from suite.suite_core.content.snapshot import body_row, repeatable_read
from suite.suite_core.content.tables import table

WINDOW_AGE = timedelta(hours=24)
WINDOW_BYTES = 4 * 2**20
CHUNK_ROWS = 2000
CHUNK_BYTES = 4 * 2**20
BUDGET_S = 20 * 60
TIMEOUT = 1500


class Mismatch(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Chunk:
    """Rows after `after` through `through` that the body holds, with the body and its stamp as read."""

    after: int
    through: int
    body: bytes
    body_sha: bytes
    body_chain: bytes
    stamp_chain: bytes | None
    rows: list[bytes]


def cursor_key(adapter: str) -> str:
    return f"suite:collab:trim-cursor:{adapter}"


def run(adapter: str, roots: Mapping[str, type], bundle: Path) -> None:
    """Trim every document that has rows to trim, from the cursor on, until the time budget runs out."""
    started = time.monotonic()
    cursor = frappe.cache.get_value(cursor_key(adapter)) or ""
    candidates = frappe.db.sql(
        f"""SELECT `id` FROM `{table(adapter, "doc")}` WHERE `id` > %s AND `mode` != 'purged'
        AND `suspect` IS NULL AND `body_rev` > `trimmed_rev` + 1 ORDER BY `id`""",
        cursor,
    )
    for (doc_id,) in candidates:
        if time.monotonic() - started > BUDGET_S:
            return

        trim(adapter, doc_id, roots, bundle)
        frappe.cache.set_value(cursor_key(adapter), doc_id)

    frappe.cache.delete_value(cursor_key(adapter))


def trim(adapter: str, doc_id: str, roots: Mapping[str, type], bundle: Path) -> None:
    """Delete the document's rows past the window, a chunk at a time, each checked first."""
    while chunk := next_chunk(adapter, doc_id, now_datetime()):
        place = admission.take_place(adapter, doc_id)
        if place is None:
            return

        try:
            check(chunk, roots, bundle)
        except Mismatch as mismatch:
            db.alert(
                f"Collab trimming: {mismatch.reason}",
                f"Kept rows {chunk.after + 1} to {chunk.through}\n{adapter} document {doc_id}",
            )
            return
        finally:
            admission.free_place(place)

        if not delete(adapter, doc_id, chunk):
            return


def next_chunk(adapter: str, doc_id: str, now: datetime) -> Chunk | None:
    """The next rows to trim, read from one snapshot, or None when none is past the window."""
    update_table = table(adapter, "update")
    with repeatable_read():
        control_rows = frappe.db.sql(
            f"""SELECT `node`, `body_rev`, `body_chain`, `body_sha`, `state_bytes`, `trimmed_rev`
            FROM `{table(adapter, "doc")}` WHERE `id` = %s AND `mode` != 'purged' AND `suspect` IS NULL""",
            doc_id,
            as_dict=True,
        )
        if not control_rows:
            return None

        doc = control_rows[0]
        after, body_rev = int(doc.trimmed_rev), int(doc.body_rev)
        covered = frappe.db.sql(
            f"""SELECT `rev`, `created`, LENGTH(`payload`) FROM `{update_table}`
            WHERE `doc_id` = %s AND `rev` > %s AND `rev` <= %s ORDER BY `rev`""",
            (doc_id, after, body_rev),
        )
        window_from = window_start(covered, int(doc.state_bytes), now)
        through = chunk_end(covered, min(window_from - 1, body_rev - 1))
        app_row = body_row(adapter, doc.node)
        if through <= after or app_row is None:
            return None

        rows = frappe.db.sql(
            f"""SELECT `payload` FROM `{update_table}` WHERE `doc_id` = %s AND `rev` > %s AND `rev` <= %s
            AND `state` = 'ok' ORDER BY `rev`""",
            (doc_id, after, through),
        )
        stamp = frappe.db.sql(
            f"SELECT `chain` FROM `{update_table}` WHERE `doc_id` = %s AND `rev` = %s", (doc_id, body_rev)
        )

    return Chunk(
        after=after,
        through=through,
        body=app_row.body,
        body_sha=bytes(doc.body_sha or b""),
        body_chain=bytes(doc.body_chain or b""),
        stamp_chain=bytes(stamp[0][0]) if stamp else None,
        rows=[bytes(payload) for (payload,) in rows],
    )


def window_start(covered, state_bytes: int, now: datetime) -> int:
    """The lowest rev in the evidence window: rows under a day old, among the newest `max(4 MiB, 2 * state)` bytes."""
    window_bytes = max(WINDOW_BYTES, 2 * state_bytes)
    newer_bytes = 0
    start = None
    for rev, created, nbytes in reversed(covered):
        if newer_bytes >= window_bytes or created < now - WINDOW_AGE:
            break

        newer_bytes += int(nbytes)
        start = int(rev)

    # With every row past the window, it starts after the newest
    return start if start is not None else int(covered[-1][0]) + 1 if covered else 0


def chunk_end(covered, through: int) -> int:
    """The last rev of the first chunk of `covered` through `through`."""
    end, count, nbytes = 0, 0, 0
    for rev, _created, row_bytes in covered:
        too_big = count and nbytes + int(row_bytes) > CHUNK_BYTES
        if int(rev) > through or count >= CHUNK_ROWS or too_big:
            break

        end, count, nbytes = int(rev), count + 1, nbytes + int(row_bytes)

    return end


def check(chunk: Chunk, roots: Mapping[str, type], bundle: Path) -> None:
    """Raises `Mismatch` unless the body is the one stamped and both pycrdt and Node find it holds every row."""
    if hashlib.sha256(chunk.body).digest() != chunk.body_sha:
        raise Mismatch("body_sha")

    if chunk.stamp_chain != chunk.body_chain:
        raise Mismatch("chain")

    if not chunk.rows:
        return

    try:
        rebuilt = compaction.compact(chunk.body, chunk.rows, roots)
    except compaction.CompactionFailed as failed:
        raise Mismatch(failed.reason) from failed

    if not rebuilt.integrated or not compaction.same_content(rebuilt.state, chunk.body, roots):
        raise Mismatch("not_held")

    try:
        held = kernel.covers(bundle, chunk.body, chunk.rows)
    except kernel.KernelFailed as failed:
        raise Mismatch("kernel_failed") from failed

    if held is False:
        raise Mismatch("kernel_not_held")


def delete(adapter: str, doc_id: str, chunk: Chunk) -> bool:
    """Delete the chunk's rows in one transaction under the control row's lock, if the body and the trim
    point are still the ones checked. Quarantined rows stay until they are resolved."""
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    locked = frappe.db.sql(
        f"""SELECT `body_sha`, `trimmed_rev` FROM `{table(adapter, "doc")}`
        WHERE `id` = %s AND `mode` != 'purged' FOR UPDATE""",
        doc_id,
        as_dict=True,
    )
    unchanged = (
        locked
        and bytes(locked[0].body_sha or b"") == chunk.body_sha
        and int(locked[0].trimmed_rev) == chunk.after
    )
    if not unchanged:
        frappe.db.rollback()
        return False

    frappe.db.sql(
        f"""DELETE FROM `{table(adapter, "update")}` WHERE `doc_id` = %s AND `rev` > %s AND `rev` <= %s
        AND `state` = 'ok'""",
        (doc_id, chunk.after, chunk.through),
    )
    frappe.db.sql(
        f"UPDATE `{table(adapter, 'doc')}` SET `trimmed_rev` = %s WHERE `id` = %s", (chunk.through, doc_id)
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    return True
