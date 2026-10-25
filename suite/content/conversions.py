"""An app's conversion records, one per old body and converter version, in the app's own table.

`convert_document` runs the app's converter on the old body the app's `read_old` answers, and hands the
answer to the app's `install`. A record with no outcome is an attempt in progress, committed before the
converter runs, so a worker that dies on a body leaves it, and a later run records that body `crashed`.
A run that fails on a body counts the failure on its record, so a body fails FAILURES times under each
converter version before it is recorded with an outcome. Only `retry_over_quota` clears a refusal, an
over_quota one, once space is freed. The record keeps `dropped`, which holds document text, so it goes
nowhere else.
"""

import json
from datetime import datetime, timedelta
from typing import Protocol

import frappe
from frappe.utils import now_datetime

from suite.content import checker, convert, live
from suite.content.editors import spec_of
from suite.content.tables import table

# How many runs fail on a body under one converter version before it is recorded `crashed`
FAILURES = 3
# How many times a row that changes under the converter is read again before the next run takes it
ATTEMPTS = 3
# An attempt this old with no outcome is one whose worker died on it, past the job's 1500 s timeout
STALE_ATTEMPT = timedelta(seconds=1500)
# Child failures that can clear up by themselves, so they count as failures rather than end the attempt
PASSING = frozenset({"child_timeout", "child_crash"})
CHANGED = "changed"
LOGGED = "logged"
OPEN_ATTEMPT = "`node` = %s AND `fingerprint` = %s AND `converter_version` = %s AND `outcome` IS NULL"


class OldBody(Protocol):
    fingerprint: str
    legacy: dict


def convert_document(app: str, node: str) -> str | None:
    """Convert `node`'s old body, reading it again if it changes; the outcome, or None to leave it to the next run."""
    conversion = spec_of(app).conversion
    started = now_datetime()
    for _attempt in range(ATTEMPTS):
        old = conversion.read_old(node)
        if old is None:
            return None

        held = held_attempt(app, node, old.fingerprint)
        if held is not None and not has_failed(held):
            return crashed_outcome(app, node, old.fingerprint, held, started)

        converted = run_converter(app, node, old, started, retry=held is not None)
        if converted is None:
            return None

        if isinstance(converted, convert.Refused):
            if converted.reason in PASSING:
                return count_failure(app, node, old.fingerprint, converted.reason)

            record(app, node, old.fingerprint, started, converted.reason)
            frappe.db.commit()  # nosemgrep: frappe-manual-commit
            live.publish_conversion(app, node, "refused")
            return converted.reason

        outcome = conversion.install(node, old, converted, started)
        if outcome not in {CHANGED, LOGGED}:
            return outcome

        drop_attempt(app, node, old.fingerprint)
        if outcome == LOGGED:
            return outcome

    return None


def crashed_outcome(app: str, node: str, fingerprint: str, held: frappe._dict, now: datetime) -> str | None:
    """Record a held attempt with no outcome that is past its job's timeout as `crashed`; skip any other."""
    if held.outcome is not None or now - held.started <= STALE_ATTEMPT:
        return None

    record(app, node, fingerprint, held.started, "crashed")
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    live.publish_conversion(app, node, "refused")
    return "crashed"


def has_failed(held: frappe._dict) -> bool:
    """Whether a run failed on this attempt and ended it with no outcome, so the next run tries again."""
    return held.outcome is None and held.finished is not None


def run_converter(
    app: str, node: str, old: OldBody, started: datetime, retry: bool
) -> convert.Converted | convert.Refused | None:
    """Run the converter on `old` after committing its attempt, which goes again when it answers nothing."""
    conversion = spec_of(app).conversion
    start_attempt(app, node, old.fingerprint, started, retry)
    try:
        converted = convert.convert(conversion.build, conversion.version, old.legacy)
    except convert.ConverterChanged:
        drop_attempt(app, node, old.fingerprint)
        raise
    except checker.CheckerBusy:
        drop_attempt(app, node, old.fingerprint)
        return None
    except Exception:
        count_failure(app, node, old.fingerprint, "crashed")
        raise

    if converted is None:
        drop_attempt(app, node, old.fingerprint)

    return converted


def held_attempt(app: str, node: str, fingerprint: str) -> frappe._dict | None:
    """Load this body's record under this converter, when a run has already started on it."""
    conversion_table = table(app, "conversion")
    rows = frappe.db.sql(
        f"""SELECT `started`, `finished`, `outcome`, `reason` FROM `{conversion_table}`
        WHERE `node` = %s AND `fingerprint` = %s AND `converter_version` = %s""",
        (node, fingerprint, spec_of(app).conversion.version),
        as_dict=True,
    )
    if not rows:
        return None

    return rows[0]


def start_attempt(app: str, node: str, fingerprint: str, started: datetime, retry: bool) -> None:
    """Commit a record with no outcome before the converter runs, so a worker that dies on it leaves a trace."""
    conversion_table = table(app, "conversion")
    key = (node, fingerprint, spec_of(app).conversion.version)
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


def count_failure(app: str, node: str, fingerprint: str, outcome: str) -> str | None:
    """Count a run's failure on this body's attempt; at FAILURES under this converter, record and answer `outcome`."""
    conversion_table = table(app, "conversion")
    key = (node, fingerprint, spec_of(app).conversion.version)
    frappe.db.sql(
        f"UPDATE `{conversion_table}` SET `failures` = `failures` + 1, `finished` = %s WHERE {OPEN_ATTEMPT}",
        (now_datetime(), *key),
    )
    frappe.db.sql(
        f"UPDATE `{conversion_table}` SET `outcome` = %s WHERE {OPEN_ATTEMPT} AND `failures` >= %s",
        (outcome, *key, FAILURES),
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    held = held_attempt(app, node, fingerprint)
    if held and held.outcome:
        live.publish_conversion(app, node, "refused")

    return held and held.outcome


def drop_attempt(app: str, node: str, fingerprint: str) -> None:
    """Let go of an attempt with no outcome: delete it, or keep the failures it counted for the next run."""
    conversion_table = table(app, "conversion")
    key = (node, fingerprint, spec_of(app).conversion.version)
    frappe.db.sql(f"DELETE FROM `{conversion_table}` WHERE {OPEN_ATTEMPT} AND `failures` = 0", key)
    frappe.db.sql(
        f"UPDATE `{conversion_table}` SET `finished` = %s WHERE {OPEN_ATTEMPT}", (now_datetime(), *key)
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit


def retry_over_quota(app: str) -> int:
    """Clear this converter's over_quota records, so the next run tries them again once space is freed."""
    conversion_table = table(app, "conversion")
    frappe.db.sql(
        f"DELETE FROM `{conversion_table}` WHERE `outcome` = 'over_quota' AND `converter_version` = %s",
        (spec_of(app).conversion.version,),
    )
    [[cleared]] = frappe.db.sql("SELECT ROW_COUNT()")
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    return cleared


def record(
    app: str,
    node: str,
    fingerprint: str,
    started: datetime,
    outcome: str,
    reason: str | None = None,
    dropped: list[dict] | None = None,
) -> None:
    """Keep the outcome of converting this body with this converter, in the caller's transaction."""
    conversion_table = table(app, "conversion")
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
            spec_of(app).conversion.version,
            started,
            now_datetime(),
            outcome,
            reason,
            dropped_json,
        ),
    )
