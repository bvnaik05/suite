"""Telling the app a document changed: after a push, and from the sweep for the edits after."""

from contextlib import suppress
from datetime import timedelta

import frappe
from frappe.utils import now_datetime

from suite.suite_core.content.adapters import node_hooks, spec_of
from suite.suite_core.content.tables import table

# A push tells the app at most this often; the sweep tells it about the edits after
TOUCH_EVERY = timedelta(minutes=10)
TOUCH_BATCH = 100


def touch(adapter: str, doc_id: str) -> None:
    """Tell the app the document changed, once per TOUCH_EVERY at most; after a push commits, and from the sweep.

    The sweep only follows a push's touch, so a document nobody has edited since keeps its date.
    """
    due_condition = """`id` = %s AND `mode` != 'purged' AND `head_rev` > `touched_rev`
        AND (`touched_at` IS NULL OR `touched_at` <= %s)"""
    now = now_datetime()
    touched_before = now - TOUCH_EVERY
    doc_table = table(adapter, "doc")
    previous_touched = frappe.db.sql(
        f"SELECT `touched_rev` FROM `{doc_table}` WHERE {due_condition}", (doc_id, touched_before)
    )
    if not previous_touched:
        return

    frappe.db.sql(
        f"UPDATE `{doc_table}` SET `touched_at` = %s, `touched_rev` = `head_rev` WHERE {due_condition}",
        (now, doc_id, touched_before),
    )
    claimed = frappe.db.sql("SELECT ROW_COUNT()")[0][0]
    node, touched_rev = frappe.db.sql(
        f"SELECT `node`, `touched_rev` FROM `{doc_table}` WHERE `id` = %s", doc_id
    )[0]
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    if not claimed:
        return

    try:
        node_hooks().touch(spec_of(adapter), node)
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
    except Exception:
        frappe.db.rollback()
        # The edits are committed; the sweep retries the touch once TOUCH_EVERY passes
        with suppress(Exception):
            frappe.db.sql(
                f"UPDATE `{doc_table}` SET `touched_rev` = %s WHERE `id` = %s AND `touched_at` = %s AND `touched_rev` = %s",
                (previous_touched[0][0], doc_id, now, touched_rev),
            )
            frappe.db.commit()  # nosemgrep: frappe-manual-commit
        with suppress(Exception):
            frappe.log_error(
                title="Collab: Drive touch failed",
                message=f"{adapter} document {doc_id}\n{frappe.get_traceback()}",
                reference_doctype="Suite Collab Settings",
            )


def sweep(adapter: str) -> None:
    touched_before = now_datetime() - TOUCH_EVERY
    due_doc_ids = frappe.db.sql(
        f"""SELECT `id` FROM `{table(adapter, "doc")}` WHERE `touched_at` <= %s AND `head_rev` > `touched_rev`
        AND `mode` != 'purged' ORDER BY `touched_at` LIMIT %s""",
        (touched_before, TOUCH_BATCH),
    )
    for (doc_id,) in due_doc_ids:
        touch(adapter, doc_id)
