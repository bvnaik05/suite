"""The layer's queued and scheduled jobs, for every app; the scheduler and the queue name them by these paths."""

import frappe

from suite.content import checkpoints, copies, log, scheduling, stage, suspect, touches, trimming
from suite.content.editors import editors, spec_of

COMPACT = "suite.content.jobs.compact"
JUDGE = "suite.content.jobs.judge"
DELETE_PURGED = "suite.content.jobs.delete_purged"
TRIM = "suite.content.jobs.trim"
CHECK_RENDER = "suite.content.jobs.check_render"


def delete_purged(app: str, doc_id: str) -> None:
    log.delete_purged(app, doc_id)


def compact(app: str, doc_id: str) -> None:
    spec = spec_of(app)
    checkpoints.run(app, doc_id, spec.part_map, JUDGE)


def trim(app: str) -> None:
    """Run one app's trimming, as its queued job."""
    spec = spec_of(app)
    trimming.run(app, spec.part_map, spec.checker_build)


def trim_logs() -> None:
    """Hourly: one trimming job per app, which resumes where the last one stopped."""
    for app in editors():
        frappe.enqueue(
            TRIM,
            queue="long",
            timeout=trimming.TIMEOUT,
            job_id=f"suite-collab-trim-{app}",
            deduplicate=True,
            app=app,
        )


def judge(app: str, doc_id: str) -> None:
    spec = spec_of(app)
    verdict = suspect.judge(app, doc_id, spec.part_map, spec.checker_build)
    if verdict in {"clean", "quarantined"}:
        scheduling.request_if_due(app, doc_id, COMPACT)


def check_render(app: str, doc_id: str) -> None:
    """Check the document's newest whole staged render as its readable copy."""
    copies.check_staged(app, doc_id)


def request_render_check(app: str, doc_id: str) -> None:
    """Enqueue the document's copy check once."""
    scheduling.enqueue(CHECK_RENDER, f"suite-collab-render-{app}-{doc_id}", app=app, doc_id=doc_id)


def sweep() -> None:
    for app, spec in editors().items():
        scheduling.sweep(app, COMPACT, purge_method=DELETE_PURGED, judge_method=JUDGE)
        touches.sweep(app)
        if spec.readable_copy is None:
            continue

        for doc_id in stage.rendered_docs(app):
            request_render_check(app, doc_id)
