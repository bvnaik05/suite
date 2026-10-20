"""What each content route does once the caller has checked access to the node: a frame answers as bytes,
anything else as a status and a JSON body, and a refusal raises `Refusal`."""

import json
from collections.abc import Callable
from http import HTTPStatus

import frappe
from frappe import _

from suite.content import copies, jobs, live, log, restores, scheduling, sessions, suspect, touches
from suite.content.pushes import push, put_piece
from suite.content.snapshot import read, rows_after, with_tombstones
from suite.content.wire import (
    PROTOCOL_VERSION,
    encode_frame,
    limits,
    open_header,
    parse_piece,
    parse_push,
)


def open_document(app: str, node: str, *, can_write: bool) -> bytes:
    if not log.enabled(app):
        return state_frame("disabled")

    doc = log.find(app, node)
    if doc is None:
        return state_frame("unconverted")

    try:
        snapshot = read(app, doc.id)
    except log.ChainBroken:
        frappe.log_error(title="Collab open: chain_break", message=f"{app} document {doc.id}")
        raise log.Refusal(503, "chain_break") from None
    if snapshot is None:
        return state_frame("unconverted")

    scheduling.request_if_due(app, doc.id, jobs.COMPACT)
    header = {**open_header(snapshot, can_write=can_write), **live_fields(app, doc)}
    return encode_frame(header, with_tombstones(snapshot), snapshot.checkpoint)


def pull_rows(app: str, node: str, since_rev: str | None, q_epoch: str | None) -> bytes:
    # The epoch is read before the rows, so a quarantine between them shows on the next pull
    doc = logged_doc(app, node)
    try:
        after_rev = int(since_rev or 0)
        seen_epoch = int(q_epoch) if q_epoch is not None else None
    except ValueError:
        raise log.Refusal(400, "malformed") from None
    epoch = int(doc.q_epoch)
    if seen_epoch is not None and seen_epoch < epoch:
        # The tab may hold a row now quarantined
        return state_frame("rebuild", q_epoch=epoch)

    if after_rev < int(doc.trimmed_rev):
        # Rows the tab still needs are gone; the body holds them
        return state_frame("rebuild", q_epoch=epoch)

    rows = rows_after(app, doc.id, max(after_rev, 0))
    scheduling.request_if_due(app, doc.id, jobs.COMPACT)
    schema_steps = json.loads(doc.schema_steps)
    header = {
        "state": "live",
        "proto": PROTOCOL_VERSION,
        "q_epoch": epoch,
        "judged": int(doc.judged),
        "schema": schema_steps[-1][1],
        **live_fields(app, doc),
    }
    if doc.verdict:
        header["verdict"] = doc.verdict
    if doc.suspect_held:
        # Readers learn only whether one change or the document is in question; the cause is for admins
        header["held"] = "bad_checkpoint" if doc.suspect_held == "bad_checkpoint" else "change"
    return encode_frame(header, rows)


def push_rows(node: str, body: bytes, authorize: Callable[[object], str]) -> tuple[int, dict]:
    """`authorize` checks the user the push names may edit `node`, and answers its app."""
    header, payload = parse_push(body)
    app = authorize(header.expected_user)
    doc = logged_doc(app, node)
    try:
        answer = push(app, doc.id, header, payload, frappe.session.user)
    except log.Refusal as refusal:
        if refusal.body["collab"] == "compacting":
            scheduling.request_if_due(app, doc.id, jobs.COMPACT, refused=True)
        raise
    touches.follow(app, doc.id, touches.TOUCH)
    touches.follow(app, doc.id, touches.VERSION)
    answer["copy"] = copies.wanted(app, doc.id)
    final_from = header.sid if header.is_final else None
    scheduling.request_if_due(app, doc.id, jobs.COMPACT, final_from=final_from)
    return 200, answer


def stage_piece(app: str, node: str, stage_id: str, piece_index: str, body: bytes) -> tuple[int, dict]:
    log.require_enabled(app)
    header, index, piece = parse_piece(app, body, stage_id, piece_index)
    doc = require_log(app, node)
    return 200, put_piece(app, doc.id, stage_id, header, index, piece, frappe.session.user)


def report_suspect(app: str, node: str, body: dict) -> tuple[int, dict]:
    """A tab's row threw when it applied it; anyone who can read the document may say so."""
    doc = logged_doc(app, node)
    rev = body.get("rev")
    if type(rev) is not int:
        raise log.Refusal(400, "malformed")

    return suspect.report_row(app, doc.id, rev, jobs.JUDGE)


def submit_render(app: str, node: str, body: dict) -> tuple[int, dict]:
    """Take an editing tab's staged render of the document at a rev, to be checked as its readable copy."""
    doc = logged_doc(app, node)
    status, answer = copies.submit(app, doc.id, body.get("stage_id"), frappe.session.user)
    if status == HTTPStatus.ACCEPTED:
        jobs.request_render_check(app, doc.id)

    return status, answer


def begin_restore(app: str, node: str, body: dict) -> tuple[int, dict]:
    """Fence the document for a restore of version `version`, after a version of what it holds now."""
    doc = logged_doc(app, node)
    seen_rev = body.get("seen_rev")
    version = body.get("version")
    if type(seen_rev) is not int or type(version) is not int:
        raise log.Refusal(400, "malformed")

    fence = restores.begin(app, doc.id, seen_rev)
    if not fence["has_milestone"]:
        take_milestone(app, doc.id, node, version, fence)

    return 200, {"token": fence["token"], "base_rev": fence["base_rev"], "fence_ms": fence["fence_ms"]}


def take_milestone(app: str, doc_id: str, node: str, version: int, fence: dict) -> None:
    """Nothing is restored without a version of the head first; a refused one lifts the fence."""
    label = _("Before restoring version {0}").format(version)
    try:
        touches.version_body(node, "milestone", label)
        restores.milestone_taken(app, doc_id, fence["head_chain"])
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
    except Exception:
        frappe.db.rollback()
        restores.cancel(app, doc_id, fence["token"])
        raise


def cancel_restore(app: str, node: str, body: dict) -> tuple[int, dict]:
    """Lift the fence the restoring tab set, when it gives up before sending the restore."""
    doc = logged_doc(app, node)
    token = body.get("token")
    if not isinstance(token, str):
        raise log.Refusal(400, "malformed")

    restores.cancel(app, doc.id, token)
    return 200, {"cancelled": 1}


def start_session(app: str, node: str, body: dict) -> tuple[int, dict]:
    doc = logged_doc(app, node)
    sid = body.get("sid")
    claim = body.get("claim")
    if not isinstance(sid, str) or len(sid) != 32 or not sid.isalnum():
        raise log.Refusal(400, "malformed")

    if claim is not None:
        claimed = sessions.claim_session(app, doc, sid, claim, frappe.session.user)
        return 200, {"claim": claimed}

    client_id = sessions.issue_session(app, doc.id, sid, frappe.session.user)
    return 200, {"client_id": client_id}


def live_fields(app: str, doc: frappe._dict) -> dict:
    """What an open and a pull both tell the tab about the document now."""
    return {
        "limits": limits(app, doc),
        "rooms": live.rooms(app, doc.id, doc.lineage),
        **restores.header_fields(app, doc.id),
    }


def require_log(app: str, node: str) -> frappe._dict:
    doc = log.find(app, node)
    if doc is None:
        raise log.Refusal(409, "unconverted")

    return doc


def logged_doc(app: str, node: str) -> frappe._dict:
    """The node's log, refused in order: collaboration off, no log."""
    log.require_enabled(app)
    return require_log(app, node)


def state_frame(state: str, **extra: int) -> bytes:
    """A frame with no rows that tells the tab what state the document is in."""
    return encode_frame({"state": state, "proto": PROTOCOL_VERSION, **extra})
