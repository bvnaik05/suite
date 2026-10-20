"""The update log's lifecycle and hash chain: the app's switch, and creating, finding and purging a log."""

import hashlib
import secrets
import struct

import frappe
from frappe.utils import now_datetime

from suite.content.tables import table

PURGE_BATCH = 500


class Refusal(Exception):
    """A collab answer other than success, sent as `{"collab": reason, ...}`."""

    def __init__(self, status: int, collab: str, /, **extra: object) -> None:
        super().__init__(collab)
        self.status = status
        self.body = {"collab": collab, **extra}


def mode(app: str) -> str:
    """Load the app's switch: "on", or "off" when it has no row."""
    filters = {
        "parent": "Suite Collab Settings",
        "parentfield": "apps",
        "app": app,
    }
    return frappe.db.get_value("Suite Collab App", filters, "mode") or "off"


def set_mode(app: str, new_mode: str) -> None:
    """Turn the app's switch to `new_mode`, adding its row when it has none."""
    settings = frappe.get_single("Suite Collab Settings")
    row = next((row for row in settings.apps if row.app == app), None)
    if row is None:
        row = settings.append("apps", {"app": app})

    row.mode = new_mode
    settings.save(ignore_permissions=True)


def enabled(app: str) -> bool:
    """Whether the app's collaboration is on."""
    return mode(app) == "on"


class ChainBroken(Exception):
    reason = "chain_break"


def require_enabled(app: str) -> None:
    """Refuse the request unless the app's collaboration is on."""
    if not enabled(app):
        raise Refusal(409, "disabled")


def chain_seed(lineage: str) -> bytes:
    """Start the hash chain of a log of `lineage`."""
    return hashlib.sha256(lineage.encode()).digest()


def chain_next(previous: bytes, rev: int, payload_sha: bytes) -> bytes:
    """Extend the hash chain by row `rev`."""
    return hashlib.sha256(previous + struct.pack(">Q", rev) + payload_sha).digest()


def find(app: str, node: str) -> frappe._dict | None:
    """`node`'s log, or None when it has none or its log is purged."""
    doc_table = table(app, "doc")
    rows = frappe.db.sql(
        f"""SELECT `id`, `lineage`, `head_rev`, `head_chain`, `q_epoch`, `verdict`, `judged`, `schema_steps`,
        `suspect_held`, `state_bytes`, `tail_bound`, `trimmed_rev` FROM `{doc_table}` WHERE `node` = %s AND `mode` != 'purged'""",
        node,
        as_dict=True,
    )
    if not rows:
        return None

    return rows[0]


def create(app: str, node: str) -> str:
    """Start an empty log for `node` in the caller's transaction; answers its id."""
    doc_id = frappe.generate_hash(length=20)
    lineage = secrets.token_hex(16)
    doc_table = table(app, "doc")
    frappe.db.sql(
        f"""INSERT INTO `{doc_table}` (`id`, `node`, `lineage`, `head_rev`, `head_chain`, `start_clocks`, `created`)
        VALUES (%s, %s, %s, 0, UNHEX(%s), '{{}}', %s)""",
        (doc_id, node, lineage, chain_seed(lineage).hex(), now_datetime()),
    )
    return doc_id


def mark_purged(app: str, node: str) -> str | None:
    """Mark `node`'s log purged in the caller's transaction, for `delete_purged` to remove; answers its id."""
    doc = find(app, node)
    if not doc:
        return None

    doc_table = table(app, "doc")
    frappe.db.sql(f"UPDATE `{doc_table}` SET `mode` = 'purged' WHERE `id` = %s", doc.id)
    return doc.id


def delete_in_batches(app: str, kind: str, doc_id: str) -> None:
    """Delete the log's rows from its `kind` table in batches, committing each."""
    kind_table = table(app, kind)
    while True:
        frappe.db.sql(f"DELETE FROM `{kind_table}` WHERE `doc_id` = %s LIMIT %s", (doc_id, PURGE_BATCH))
        [(deleted,)] = frappe.db.sql("SELECT ROW_COUNT()")
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        if deleted < PURGE_BATCH:
            break


def delete_purged(app: str, doc_id: str) -> None:
    """Delete a purged log's rows in batches, each committed, then its control row. Safe to run again."""
    doc_table = table(app, "doc")
    purged = frappe.db.sql(f"SELECT 1 FROM `{doc_table}` WHERE `id` = %s AND `mode` = 'purged'", doc_id)
    if not purged:
        return

    for kind in ("update", "checkpoint", "session", "stage", "recovery", "projection", "copy"):
        delete_in_batches(app, kind, doc_id)

    frappe.db.sql(f"DELETE FROM `{doc_table}` WHERE `id` = %s AND `mode` = 'purged'", doc_id)
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
