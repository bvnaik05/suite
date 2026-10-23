"""Turn an old Writer document into a collaborative one.

`convert_document` runs the converter on the row as it reads it, and `install_conversion` installs
the answer in one transaction under the row's lock. Every check runs before the first write, and a
refusal writes only its record. A record with no outcome is committed before the converter runs, so a
worker that dies on a body leaves it, and a later run records that body `crashed`. A run that fails on
a body, or a child that crashes or times out on it, counts the failure on its record and the next run
tries again; the record counts per converter version, so a body fails FAILURES times under each version
before it is recorded `crashed`, or with the child's reason. Only `retry_over_quota` clears a refusal,
an over_quota one, once space is freed. The record keeps `dropped`, which holds document text, so it
goes nowhere else.
"""

import base64
import hashlib
import json
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NotRequired, TypedDict

import frappe
import pycrdt
from frappe import _
from frappe.utils import now_datetime

from suite import drive
from suite.content import checker, compaction, convert, copies, live, log
from suite.content.checkpoints import replace_start
from suite.content.tables import table
from suite.writer import content as writer_content

DOCTYPE = "Writer Document"
FIELDS = ("content", "html", "collab", "ycomments")
# How many times a row that changes under the converter is read again before the next run takes it
ATTEMPTS = 3
# An attempt this old with no outcome is one whose worker died on it, past the job's 1500 s timeout
STALE_ATTEMPT = timedelta(seconds=1500)
# How many runs fail on a body under one converter version before it is recorded `crashed`
FAILURES = 3
# Child failures that can clear up by themselves, so they count as failures rather than end the attempt
PASSING = frozenset({"child_timeout", "child_crash"})
OPEN_ATTEMPT = "`node` = %s AND `fingerprint` = %s AND `converter_version` = %s AND `outcome` IS NULL"
CHANGED = "changed"
LOGGED = "logged"


@dataclass(frozen=True)
class OldDocument:
    docname: str
    legacy: dict = field(repr=False)
    fingerprint: str
    threads: list[dict] = field(repr=False)


class ConversionStatus(TypedDict):
    state: str
    reason: NotRequired[str]
    rooms: NotRequired[live.Rooms]


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
        if held is not None and not has_failed(held):
            return crashed_outcome(node, old.fingerprint, held, started)

        converted = run_converter(node, old, started, retry=held is not None)
        if converted is None:
            return None

        if isinstance(converted, convert.Refused):
            if converted.reason in PASSING:
                return count_failure(node, old.fingerprint, converted.reason)

            record(node, old.fingerprint, started, converted.reason)
            frappe.db.commit()  # nosemgrep: frappe-manual-commit
            live.publish_conversion(writer_content.APP, node, "refused")
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
    live.publish_conversion(writer_content.APP, node, "refused")
    return "crashed"


def has_failed(held: frappe._dict) -> bool:
    """Whether a run failed on this attempt and ended it with no outcome, so the next run tries again."""
    return held.outcome is None and held.finished is not None


def run_converter(
    node: str, old: OldDocument, started: datetime, retry: bool
) -> convert.Converted | convert.Refused | None:
    """Run the converter on `old` after committing its attempt, which goes again when it answers nothing."""
    start_attempt(node, old.fingerprint, started, retry)
    try:
        converted = convert.convert(
            writer_content.CONVERTER_BUILD, writer_content.CONVERTER_VERSION, old.legacy
        )
    except convert.ConverterChanged:
        drop_attempt(node, old.fingerprint)
        raise
    except checker.CheckerBusy:
        drop_attempt(node, old.fingerprint)
        return None
    except Exception:
        count_failure(node, old.fingerprint, "crashed")
        raise

    if converted is None:
        drop_attempt(node, old.fingerprint)

    return converted


def held_attempt(node: str, fingerprint: str) -> frappe._dict | None:
    """Load this body's record under this converter, when a run has already started on it."""
    conversion_table = table(writer_content.APP, "conversion")
    rows = frappe.db.sql(
        f"""SELECT `started`, `finished`, `outcome`, `reason` FROM `{conversion_table}`
        WHERE `node` = %s AND `fingerprint` = %s AND `converter_version` = %s""",
        (node, fingerprint, writer_content.CONVERTER_VERSION),
        as_dict=True,
    )
    if not rows:
        return None

    return rows[0]


def start_attempt(node: str, fingerprint: str, started: datetime, retry: bool) -> None:
    """Commit a record with no outcome before the converter runs, so a worker that dies on it leaves a trace."""
    conversion_table = table(writer_content.APP, "conversion")
    key = (node, fingerprint, writer_content.CONVERTER_VERSION)
    if retry:
        frappe.db.sql(
            f"UPDATE `{conversion_table}` SET `started` = %s, `finished` = NULL WHERE {OPEN_ATTEMPT}",
            (started, *key),
        )
    else:
        frappe.db.sql(
            f"""INSERT INTO `{conversion_table}` (`node`, `fingerprint`, `converter_version`, `started`)
            VALUES (%s, %s, %s, %s)""",
            (*key, started),
        )

    frappe.db.commit()  # nosemgrep: frappe-manual-commit


def count_failure(node: str, fingerprint: str, outcome: str) -> str | None:
    """Count a run's failure on this body's attempt; at FAILURES under this converter, record and answer `outcome`."""
    conversion_table = table(writer_content.APP, "conversion")
    key = (node, fingerprint, writer_content.CONVERTER_VERSION)
    frappe.db.sql(
        f"UPDATE `{conversion_table}` SET `failures` = `failures` + 1, `finished` = %s WHERE {OPEN_ATTEMPT}",
        (now_datetime(), *key),
    )
    frappe.db.sql(
        f"UPDATE `{conversion_table}` SET `outcome` = %s WHERE {OPEN_ATTEMPT} AND `failures` >= %s",
        (outcome, *key, FAILURES),
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    held = held_attempt(node, fingerprint)
    if held and held.outcome:
        live.publish_conversion(writer_content.APP, node, "refused")

    return held and held.outcome


def drop_attempt(node: str, fingerprint: str) -> None:
    """Let go of an attempt with no outcome: delete it, or keep the failures it counted for the next run."""
    conversion_table = table(writer_content.APP, "conversion")
    key = (node, fingerprint, writer_content.CONVERTER_VERSION)
    frappe.db.sql(f"DELETE FROM `{conversion_table}` WHERE {OPEN_ATTEMPT} AND `failures` = 0", key)
    frappe.db.sql(
        f"UPDATE `{conversion_table}` SET `finished` = %s WHERE {OPEN_ATTEMPT}", (now_datetime(), *key)
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit


def retry_over_quota() -> int:
    """Clear this converter's over_quota records, so the next run tries them again once space is freed."""
    conversion_table = table(writer_content.APP, "conversion")
    frappe.db.sql(
        f"DELETE FROM `{conversion_table}` WHERE `outcome` = 'over_quota' AND `converter_version` = %s",
        (writer_content.CONVERTER_VERSION,),
    )
    [[cleared]] = frappe.db.sql("SELECT ROW_COUNT()")
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    return cleared


def conversion_status(node: str) -> ConversionStatus:
    """Answer whether the next run converts `node`'s body, with the rooms told its outcome, or this converter refused it; the reason for System Managers."""
    legacy = frappe.db.get_value(DOCTYPE, {"node": node}, list(FIELDS), as_dict=True)
    held = held_attempt(node, fingerprint_of(legacy or {}))
    if held is None or held.outcome in {None, "converted"}:
        pending: ConversionStatus = {
            "state": "pending",
            "rooms": live.conversion_rooms(writer_content.APP, node),
        }
        cause = convert.blocked_cause()
        if cause and "System Manager" in frappe.get_roles():
            pending["reason"] = cause

        return pending

    status: ConversionStatus = {"state": "refused"}
    if "System Manager" in frappe.get_roles():
        status["reason"] = held.outcome
        if held.reason:
            status["reason"] = f"{held.outcome}: {held.reason}"

    return status


def fingerprint_of(legacy: dict) -> str:
    """Hash the old body's stores, so a changed body is converted again."""
    return hashlib.sha256(json.dumps([legacy.get(name) for name in FIELDS]).encode()).hexdigest()


def read_old(node: str, *, lock: bool = False) -> OldDocument | None:
    """Read the old body and the node's Drive threads, or None once a purge took the row; with `lock`, lock it first."""
    row = frappe.db.get_value(DOCTYPE, {"node": node}, ["name", *FIELDS], as_dict=True, for_update=lock)
    if row is None:
        return None

    if lock:
        # Lock the node with no plain read before it, which would take a snapshot missing a thread made meanwhile
        frappe.db.sql("SELECT `name` FROM `tabDrive Node` WHERE `name` = %s FOR UPDATE", (node,))

    legacy = {name: row[name] for name in FIELDS}
    return OldDocument(row.name, legacy, fingerprint_of(legacy), drive.comment_threads(node))


def install_conversion(node: str, old: OldDocument, converted: convert.Converted, started: datetime) -> str:
    """Install `converted` whole or not at all: converted, a refusal, logged, or changed."""
    try:
        dropped = write_conversion(node, old, converted)
    except ConversionRefused as refused:
        frappe.db.rollback()
        record(node, old.fingerprint, started, refused.outcome, refused.reason)
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        live.publish_conversion(writer_content.APP, node, "refused")
        return refused.outcome
    except Exception:
        frappe.db.rollback()
        count_failure(node, old.fingerprint, "crashed")
        raise

    if dropped is None:
        frappe.db.rollback()
        return CHANGED if log.find(writer_content.APP, node) is None else LOGGED

    record(node, old.fingerprint, started, "converted", dropped=dropped)
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    frappe.clear_document_cache(DOCTYPE, old.docname)
    live.publish_conversion(writer_content.APP, node, "converted")
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
