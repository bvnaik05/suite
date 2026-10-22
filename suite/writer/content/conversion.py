"""Turn an old Writer document into a collaborative one.

`convert_document` runs the converter on the row as it reads it, and `install_conversion` installs
the answer in one transaction under the row's lock. Every check runs before the first write, and a
refusal writes only its record. A record with no outcome is committed before the converter runs, so a
worker that dies on a body leaves it, and a later run records that body `crashed`. The record keeps
`dropped`, which holds document text, so it goes nowhere else.
"""

import base64
import hashlib
import json
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import frappe
import pycrdt
from frappe import _
from frappe.utils import now_datetime

from suite import drive
from suite.content import compaction, convert, copies, log
from suite.content.checkpoints import replace_start
from suite.content.tables import table
from suite.writer import content as writer_content

DOCTYPE = "Writer Document"
FIELDS = ("content", "html", "collab", "ycomments")
# How many times a row that changes under the converter is read again before the next run takes it
ATTEMPTS = 3
# An attempt this old with no outcome is one whose worker died on it, past the job's 1500 s timeout
STALE_ATTEMPT = timedelta(seconds=1500)
CHANGED = "changed"
LOGGED = "logged"


@dataclass(frozen=True)
class OldDocument:
    docname: str
    legacy: dict = field(repr=False)
    fingerprint: str
    threads: list[dict] = field(repr=False)


class ConversionRefused(Exception):
    def __init__(self, outcome: str, reason: str | None = None) -> None:
        super().__init__(outcome)
        self.outcome = outcome
        self.reason = reason


def convert_document(node: str) -> str | None:
    """Convert `node`'s old body, reading it again if it changes; the outcome, or None to leave it to the next run."""
    started = now_datetime()
    for _attempt in range(ATTEMPTS):
        old = read_old(node)
        if old is None:
            return None

        held = held_attempt(node, old.fingerprint)
        if held is not None:
            return crashed_outcome(node, old.fingerprint, held, started)

        converted = run_converter(node, old, started)
        if converted is None:
            return None

        if isinstance(converted, convert.Refused):
            record(node, old.fingerprint, started, converted.reason)
            frappe.db.commit()  # nosemgrep: frappe-manual-commit
            return converted.reason

        outcome = install_conversion(node, old, converted, started)
        if outcome not in {CHANGED, LOGGED}:
            return outcome

        drop_attempt(node, old.fingerprint)
        if outcome == LOGGED:
            return outcome

    return None


def crashed_outcome(node: str, fingerprint: str, held: frappe._dict, now: datetime) -> str | None:
    """Record a held attempt with no outcome that is past its job's timeout as `crashed`; skip any other."""
    if held.outcome is not None or now - held.started <= STALE_ATTEMPT:
        return None

    record(node, fingerprint, held.started, "crashed")
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    return "crashed"


def run_converter(
    node: str, old: OldDocument, started: datetime
) -> convert.Converted | convert.Refused | None:
    """Run the converter on `old` after committing its attempt, which goes again when it answers nothing."""
    start_attempt(node, old.fingerprint, started)
    try:
        converted = convert.convert(
            writer_content.CONVERTER_BUILD, writer_content.CONVERTER_VERSION, old.legacy
        )
    except convert.ConverterChanged:
        drop_attempt(node, old.fingerprint)
        raise

    if converted is None:
        drop_attempt(node, old.fingerprint)

    return converted


def held_attempt(node: str, fingerprint: str) -> frappe._dict | None:
    """Load this body's record under this converter, when a run has already started on it."""
    conversion_table = table(writer_content.APP, "conversion")
    rows = frappe.db.sql(
        f"""SELECT `started`, `outcome` FROM `{conversion_table}`
        WHERE `node` = %s AND `fingerprint` = %s AND `converter_version` = %s""",
        (node, fingerprint, writer_content.CONVERTER_VERSION),
        as_dict=True,
    )
    if not rows:
        return None

    return rows[0]


def start_attempt(node: str, fingerprint: str, started: datetime) -> None:
    """Commit a record with no outcome before the converter runs, so a worker that dies on it leaves a trace."""
    conversion_table = table(writer_content.APP, "conversion")
    frappe.db.sql(
        f"""INSERT INTO `{conversion_table}` (`node`, `fingerprint`, `converter_version`, `started`)
        VALUES (%s, %s, %s, %s)""",
        (node, fingerprint, writer_content.CONVERTER_VERSION, started),
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit


def drop_attempt(node: str, fingerprint: str) -> None:
    """Delete an attempt that ended with no outcome, so the next run starts it afresh."""
    conversion_table = table(writer_content.APP, "conversion")
    frappe.db.sql(
        f"""DELETE FROM `{conversion_table}` WHERE `node` = %s AND `fingerprint` = %s
        AND `converter_version` = %s AND `outcome` IS NULL""",
        (node, fingerprint, writer_content.CONVERTER_VERSION),
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit


def read_old(node: str, *, lock: bool = False) -> OldDocument | None:
    """Read the old body and the node's Drive threads, or None once a purge took the row; with `lock`, lock it first."""
    row = frappe.db.get_value(DOCTYPE, {"node": node}, ["name", *FIELDS], as_dict=True, for_update=lock)
    if row is None:
        return None

    legacy = {name: row[name] for name in FIELDS}
    fingerprint = hashlib.sha256(json.dumps([legacy[name] for name in FIELDS]).encode()).hexdigest()
    return OldDocument(row.name, legacy, fingerprint, drive.comment_threads(node))


def install_conversion(node: str, old: OldDocument, converted: convert.Converted, started: datetime) -> str:
    """Install `converted` whole or not at all: converted, a refusal, logged, or changed."""
    try:
        dropped = write_conversion(node, old, converted)
    except ConversionRefused as refused:
        frappe.db.rollback()
        record(node, old.fingerprint, started, refused.outcome, refused.reason)
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        return refused.outcome
    except Exception:
        frappe.db.rollback()
        raise

    if dropped is None:
        frappe.db.rollback()
        return CHANGED if log.find(writer_content.APP, node) is None else LOGGED

    record(node, old.fingerprint, started, "converted", dropped=dropped)
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    frappe.clear_document_cache(DOCTYPE, old.docname)
    return "converted"


def write_conversion(node: str, old: OldDocument, converted: convert.Converted) -> list[dict] | None:
    """Check, then write, `converted` in the caller's transaction; what it dropped, or None if it can't start."""
    if read_old(node, lock=True) != old or log.find(writer_content.APP, node):
        return None

    names = thread_names(node, old.legacy["ycomments"], old.threads)
    anchors = {names.get(key): anchor for key, anchor in converted.anchors.items()}
    if None in anchors:
        raise ConversionRefused("check", "orphan")

    html = checked_html(old, converted)
    keep_old_version(node)
    doc_id = log.create(writer_content.APP, node)
    replace_start(writer_content.APP, doc_id, converted.state, writer_content.DECLARED["schema"])
    drive.install_threads(node, anchors, [old_thread(thread) for thread in converted.threads])
    clear_ycomments(old.docname)
    if copies.replace_copy(writer_content.APP, doc_id, 1, html, writer_content.EDITOR.readable_copy) is None:
        raise ConversionRefused("check", "copy")

    named = set(names.values())
    unknown = [thread["name"] for thread in old.threads if thread["name"] not in named]
    return [*converted.dropped, *({"kind": "unknown-anchor", "thread": name} for name in unknown)]


def checked_html(old: OldDocument, converted: convert.Converted) -> str:
    """Answer the readable copy to install; refuse a state the checker can't take whole, or a copy that doesn't hold it."""
    try:
        if not compaction.compact(converted.state, [], writer_content.PART_MAP).integrated:
            raise ConversionRefused("check", "fallback")
    except compaction.CompactionFailed as failed:
        raise ConversionRefused("check", failed.reason) from None

    if not converted.html:
        if old.legacy["html"]:
            raise ConversionRefused("check", "empty")

        return ""

    clean, text = copies.cleaned(converted.html)
    if not writer_content.is_html_complete(converted.state, clean, text):
        raise ConversionRefused("check", "copy")

    return clean


def keep_old_version(node: str) -> None:
    """Keep the old body as a version before anything writes it."""
    try:
        drive.take_version(node, kind="milestone", label=_("Before collaboration"))
    except drive.DriveOverQuota:
        raise ConversionRefused("over_quota") from None


def thread_names(node: str, ycomments: str | None, threads: list[dict]) -> dict[str, str]:
    """Each old comment's Drive thread, as Build named it; refuses a comment or reply no thread holds."""
    held = {thread["name"]: set(thread["comments"]) for thread in threads}
    names: dict[str, str] = {}
    for key, ids in old_comment_ids(ycomments).items():
        name = held_name(node, key, held)
        if name is None or any(held_name(node, id_, held[name]) is None for id_ in ids):
            raise ConversionRefused("check", "orphan")

        names[key] = name

    return names


def held_name(node: str, source_id: str, held: Collection[str]) -> str | None:
    """Find the name Build gave `source_id` among `held`: its own, or its rename when another node held it."""
    for name in (source_id, renamed_id(node, source_id)):
        if name in held:
            return name

    return None


def renamed_id(node: str, source_id: str) -> str:
    """Rename an id another node held as Build does (build/comments.py `_renamed_id`); a test pins it."""
    material = json.dumps(
        ["drive-comment-rename/1", node, source_id], ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(material.encode()).hexdigest()


def old_comment_ids(ycomments: str | None) -> dict[str, list[str]]:
    """Each thread id in the old comments and the ids of its comment and replies; refuses unreadable ones."""
    if not ycomments:
        return {}

    try:
        doc = pycrdt.Doc()
        doc.apply_update(base64.b64decode(ycomments, validate=True))
        values = doc.get("comments", type=pycrdt.Map).to_py()
        ids: dict[str, list[str]] = {}
        for key, value in values.items():
            ids[key] = [entry["id"] for entry in [value, *(value.get("replies") or [])]]

        return ids
    except Exception:
        raise ConversionRefused("check", "comments") from None


def old_thread(thread: dict) -> dict:
    """Map a 2023 thread to the shape Drive installs."""
    comments: list[dict] = []
    for comment in thread["comments"]:
        comments.append(
            {"content": comment["content"], "author_name": comment["authorName"], "time": comment["time"]}
        )

    return {"anchor": thread["anchor"], "comments": comments}


def clear_ycomments(docname: str) -> None:
    """Empty the old comments once Drive holds their anchors."""
    frappe.db.set_value(DOCTYPE, docname, "ycomments", None, update_modified=False)


def record(
    node: str,
    fingerprint: str,
    started: datetime,
    outcome: str,
    reason: str | None = None,
    dropped: list[dict] | None = None,
) -> None:
    """Keep the outcome of converting this body with this converter, in the caller's transaction."""
    conversion_table = table(writer_content.APP, "conversion")
    dropped_json = None
    if dropped is not None:
        dropped_json = json.dumps(dropped)

    frappe.db.sql(
        f"""INSERT INTO `{conversion_table}`
        (`node`, `fingerprint`, `converter_version`, `started`, `finished`, `outcome`, `reason`, `dropped`)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE `started` = VALUES(`started`), `finished` = VALUES(`finished`),
        `outcome` = VALUES(`outcome`), `reason` = VALUES(`reason`), `dropped` = VALUES(`dropped`)""",
        (
            node,
            fingerprint,
            writer_content.CONVERTER_VERSION,
            started,
            now_datetime(),
            outcome,
            reason,
            dropped_json,
        ),
    )
