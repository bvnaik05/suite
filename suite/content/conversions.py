"""An app's conversion records, one per old body and converter version, in the app's own table.

A record with no outcome is an attempt in progress. A run that fails on a body counts the failure on its
record, so a body fails FAILURES times under each converter version before it is recorded with an
outcome. Only `retry_over_quota` clears a refusal, an over_quota one, once space is freed. The record
keeps `dropped`, which holds document text, so it goes nowhere else.
"""

import json
from datetime import datetime

import frappe
from frappe.utils import now_datetime

from suite.content import live
from suite.content.editors import spec_of
from suite.content.tables import table

# How many runs fail on a body under one converter version before it is recorded `crashed`
FAILURES = 3
OPEN_ATTEMPT = "`node` = %s AND `fingerprint` = %s AND `converter_version` = %s AND `outcome` IS NULL"


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
