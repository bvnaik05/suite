"""Documents a compaction can't take: find the row that breaks them and quarantine it, or hold them.

A compaction that throws, or that stays wrong after its re-compaction, marks the document
suspect, and compactions skip it from then on. A job judges it: the product's Node checker finds
the first row the browsers' Yjs or the editor can't take, and when it finds none, pycrdt is
probed the same way. That row and its dependents are quarantined, each with a recovery copy,
and the document is cleared only if pycrdt then takes what is left. Without a verdict (no Node,
a bad checkpoint, a checker or a judge that fails), when pycrdt still refuses, or when the
compaction fails again after a clean verdict, the document is held: its rows stay, pushes are
refused and an admin reviews it.
A document only a tab's report marked is held only on what its rows show: without a verdict it
is cleared as unjudged, so a report alone never pauses saving.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import frappe
from frappe.utils.background_jobs import get_redis_conn

from suite import drive
from suite.content import admission, checker, compaction, db, live, quarantine
from suite.content.log import Refusal
from suite.content.pushes import SUSPECT_RETRY_MS
from suite.content.scheduling import enqueue
from suite.content.snapshot import read
from suite.content.tables import table

# The compaction failures that come from the CRDT library itself, not from the rows' shape or the host
REASONS = frozenset({"unreadable", "content_mismatch", "reencode_mismatch", "not_contained", "fallback"})
REPORT_EVERY_S = 60


@dataclass(frozen=True)
class Judging:
    """One judge run's document and what it judges the rows with."""

    app: str
    doc_id: str
    part_map: Mapping[str, type]
    bundle: Path


def mark_suspect(app: str, doc_id: str, reason: str, method: str) -> None:
    is_newly_marked = db.claim(
        f"UPDATE `{table(app, 'doc')}` SET `suspect` = %s WHERE `id` = %s AND `suspect` IS NULL",
        (reason, doc_id),
    )
    if is_newly_marked:
        alert(app, doc_id, f"suspect: {reason}", "The compaction could not take the rows; a job judges them")
        request_judge(app, doc_id, method)


def report_row(app: str, doc_id: str, rev: int, method: str) -> tuple[int, dict]:
    """A tab's report that row `rev` threw when it applied it; answers the status and body to send.

    Rows the body holds already passed the compaction's checks, so the throw was the tab's own
    and the answer is `clean` at once. Otherwise the document is marked suspect and a job judges it;
    the tab reads the verdict on a pull once `judged` passes the number in the answer.
    """
    control_row = frappe.db.sql(
        f"SELECT `head_rev`, `body_rev`, `suspect_held`, `judged` FROM `{table(app, 'doc')}` WHERE `id` = %s",
        doc_id,
        as_dict=True,
    )[0]
    if not 0 < rev <= int(control_row.head_rev):
        raise Refusal(400, "malformed")

    if rev <= int(control_row.body_rev):
        return 200, {"verdict": "clean", "judged": int(control_row.judged)}

    if control_row.suspect_held:
        raise Refusal(423, "paused", reason="suspect", retry_ms=SUSPECT_RETRY_MS)

    is_report_heard = db.claim(
        f"""UPDATE `{table(app, "doc")}` SET `suspect_reported_at` = NOW(6) WHERE `id` = %s
        AND (`suspect_reported_at` IS NULL OR `suspect_reported_at` <= NOW(6) - INTERVAL %s SECOND)""",
        (doc_id, REPORT_EVERY_S),
    )
    if not is_report_heard:
        raise Refusal(423, "busy", retry_ms=REPORT_EVERY_S * 1000)

    mark_suspect(app, doc_id, "client", method)
    return 202, {"collab": "judging", "judged": int(control_row.judged)}


def request_judge(app: str, doc_id: str, method: str) -> None:
    enqueue(method, f"suite-collab-judge-{app}-{doc_id}", app=app, doc_id=doc_id)


def judge(app: str, doc_id: str, part_map: Mapping[str, type], bundle: Path) -> str | None:
    """Judge a suspect document; answers `quarantined`, `clean`, `held` or `unjudged`, or None when it isn't suspect.

    A judge takes one of the bench's compaction places; with none free it answers `busy` and the sweep asks again.
    An admin's re-judge asked while it runs finds its job queued already, so the judge judges again before it ends.
    """
    suspect_reason = suspect_of(app, doc_id)
    if not suspect_reason:
        return None

    redis = get_redis_conn()
    rejudge_redis_key = rejudge_key(app, doc_id)
    place = admission.take_place(app, doc_id)
    if place is None:
        return "busy"

    judging = Judging(app, doc_id, part_map, bundle)
    try:
        redis.delete(rejudge_redis_key)
        verdict = verdict_of(judging, suspect_reason)
        while redis.delete(rejudge_redis_key) and (suspect_reason := suspect_of(app, doc_id)):
            verdict = verdict_of(judging, suspect_reason)
        return verdict
    finally:
        admission.free_place(place)


def verdict_of(judging: Judging, suspect_reason: str) -> str | None:
    try:
        return judge_rows(judging, suspect_reason)
    except BaseException as error:  # pycrdt panics derive from BaseException
        if isinstance(error, KeyboardInterrupt | SystemExit):
            raise

        frappe.db.rollback()
        return unsettled(judging.app, judging.doc_id, suspect_reason, "judge_failed", type(error).__name__)


def rejudge_key(app: str, doc_id: str) -> str:
    return f"suite:collab:rejudge:{frappe.local.site}:{app}:{doc_id}"


def judge_rows(judging: Judging, suspect_reason: str) -> str | None:
    app = judging.app
    doc_id = judging.doc_id
    part_map = judging.part_map
    snapshot = read(app, doc_id, integrated=True)
    if snapshot is None:
        return None

    checkpoint = snapshot.checkpoint
    revs = [rev for rev, _payload in snapshot.rows]
    rows = snapshot.payloads()
    try:
        verdict = checker.judge(judging.bundle, checkpoint, rows)
    except checker.CheckerFailed as error:
        return unsettled(app, doc_id, suspect_reason, "checker_failed", repr(error))

    if verdict is None:
        return unsettled(
            app,
            doc_id,
            suspect_reason,
            "no_node",
            "Node 24 or the product's checker is missing on this host",
        )

    index = verdict.index
    reason = "editor_schema" if verdict.reason.startswith("schema") else "yjs_refused"
    if index is None:
        index = first_refused(checkpoint, rows, part_map)
        reason = "pycrdt_refused"

    if index == -1:
        return hold_document(app, doc_id, "bad_checkpoint", verdict.reason or "pycrdt refuses the checkpoint")

    if index is not None:
        try:
            quarantine.quarantine(app, doc_id, {revs[index]}, reason)
        except drive.DriveNotFound as error:
            return hold_document(app, doc_id, "unowned_row", repr(error))

        reread = read(app, doc_id, integrated=True)
        if reread:
            after_rows = reread.payloads()
            if pycrdt_refuses(reread.checkpoint, after_rows, part_map):
                return hold_document(
                    app, doc_id, "still_refused", f"rev {revs[index]} quarantined, pycrdt still refuses"
                )

    nothing_refused = index is None
    library_failure = suspect_reason in REASONS
    if nothing_refused and library_failure and judged_clean(app, doc_id):
        return hold_document(
            app, doc_id, "unreproduced", "Judged clean before, and the compaction still fails"
        )

    outcome = "clean" if nothing_refused else "quarantined"
    clean_mark = suspect_reason if nothing_refused and library_failure else None
    clear_suspect(app, doc_id, outcome, clean_mark=clean_mark)
    return outcome


def rejudge(app: str, doc_id: str, method: str) -> bool:
    """An admin asks for a new verdict; a held document is unheld so the judge and the sweep take it again."""
    if not suspect_of(app, doc_id):
        return False

    frappe.db.sql(f"UPDATE `{table(app, 'doc')}` SET `suspect_held` = NULL WHERE `id` = %s", doc_id)
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    live.publish_change(app, doc_id, "released")
    redis = get_redis_conn()
    redis.set(rejudge_key(app, doc_id), 1, ex=admission.LEASE_SECONDS)
    alert(app, doc_id, "suspect re-judged", f"{frappe.session.user} asked for a new verdict")
    request_judge(app, doc_id, method)
    return True


def release(app: str, doc_id: str) -> bool:
    """An admin clears a suspect document as `unjudged`: saving and compactions go on and its rows stay."""
    if not suspect_of(app, doc_id):
        return False

    clear_suspect(app, doc_id, "unjudged")
    live.publish_change(app, doc_id, "released")
    alert(app, doc_id, "suspect cleared", f"{frappe.session.user} cleared it without a verdict")
    return True


def first_refused(checkpoint: bytes | None, rows: list[bytes], part_map: Mapping[str, type]) -> int | None:
    """The index of the first row a compaction refuses, -1 for the checkpoint, None when it takes them all."""
    if not pycrdt_refuses(checkpoint, rows, part_map):
        return None

    if checkpoint and pycrdt_refuses(checkpoint, [], part_map):
        return -1

    # Every prefix up to `good` rows compacts and the prefix of `bad` rows does not
    good, bad = 0, len(rows)
    while bad - good > 1:
        middle = (good + bad) // 2
        if pycrdt_refuses(checkpoint, rows[:middle], part_map):
            bad = middle
        else:
            good = middle
    return bad - 1


def pycrdt_refuses(checkpoint: bytes | None, rows: list[bytes], part_map: Mapping[str, type]) -> bool:
    """Whether the compaction refuses these rows for a reason that marks a document suspect."""
    if not checkpoint and not rows:
        return False

    try:
        compacted = compaction.compact(checkpoint, rows, part_map)
        return not compacted.integrated
    except compaction.CompactionFailed as error:
        return error.reason in REASONS


def judged_clean(app: str, doc_id: str) -> bool:
    """Whether a judge found a compaction's suspect clean since the last checkpoint install."""
    judged_row = frappe.db.sql(
        f"SELECT `suspect_judged_clean` FROM `{table(app, 'doc')}` WHERE `id` = %s", doc_id
    )
    return bool(judged_row[0][0])


def fallback_judged_lately(app: str, doc_id: str) -> bool:
    """Whether a judge found a fallback clean in the last day, so another fallback needs no judge."""
    found = frappe.db.sql(
        f"""SELECT 1 FROM `{table(app, "doc")}` WHERE `id` = %s
        AND `fallback_judged_clean_at` > NOW(6) - INTERVAL 1 DAY""",
        doc_id,
    )
    return bool(found)


def suspect_of(app: str, doc_id: str) -> str | None:
    found = frappe.db.sql(f"SELECT `suspect` FROM `{table(app, 'doc')}` WHERE `id` = %s", doc_id)
    return found[0][0] if found else None


def hold_document(app: str, doc_id: str, hold_reason: str, detail: str) -> str | None:
    """Answers None when an admin cleared the document while it was judged."""
    is_held = db.claim(
        f"""UPDATE `{table(app, "doc")}` SET `suspect_held` = %s, `verdict` = 'held', `judged` = `judged` + 1
        WHERE `id` = %s AND `suspect` IS NOT NULL""",
        (hold_reason, doc_id),
    )
    if not is_held:
        return None

    live.publish_change(app, doc_id, "held")
    alert(
        app,
        doc_id,
        f"suspect held: {hold_reason}",
        f"Saving is paused until an admin reviews it. {detail}",
    )
    return "held"


def unsettled(app: str, doc_id: str, suspect_reason: str, hold_reason: str, detail: str) -> str | None:
    """A judge that can't settle a document holds it only when a compaction marked it; a tab's report alone never pauses saving."""
    if suspect_reason != "client":
        return hold_document(app, doc_id, hold_reason, detail)

    clear_suspect(app, doc_id, "unjudged")
    alert(
        app,
        doc_id,
        f"suspect unjudged: {hold_reason}",
        f"A tab's report was not judged and saving goes on. {detail}",
    )
    return "unjudged"


def clear_suspect(app: str, doc_id: str, verdict: str, *, clean_mark: str | None = None) -> None:
    """`clean_mark` is the compaction's reason when a judge found its suspect clean.

    A verdict ends the failed compaction's backoff, so the document compacts at once.
    """
    frappe.db.sql(
        f"""UPDATE `{table(app, "doc")}` SET `suspect` = NULL, `suspect_held` = NULL, `verdict` = %s,
        `judged` = `judged` + 1, `suspect_judged_clean` = `suspect_judged_clean` OR %s,
        `fallback_judged_clean_at` = IF(%s, NOW(6), `fallback_judged_clean_at`),
        `next_compaction_at` = IF(%s, NULL, `next_compaction_at`) WHERE `id` = %s""",
        (
            verdict,
            clean_mark is not None,
            clean_mark == "fallback",
            verdict in {"clean", "quarantined"},
            doc_id,
        ),
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit


def alert(app: str, doc_id: str, title: str, message: str) -> None:
    db.alert(f"Collab document {title}", f"{message}\n{app} document {doc_id}")
