"""Readable copies (4i): a tab's render, checked against the document at its rev, then put in the app's row.

The app's copy field is written only here, under the projection row's lock, and the projection row keeps
the sha of what was written. Anything else found in the field is kept as evidence before it is replaced.
"""

import hashlib

import frappe
import pycrdt
from bs4 import BeautifulSoup
from frappe.utils import now_datetime
from frappe.utils.html_utils import sanitize_html

from suite.suite_core.content import compaction, db
from suite.suite_core.content.adapters import spec_of
from suite.suite_core.content.snapshot import Snapshot, read
from suite.suite_core.content.tables import table


def install(adapter: str, doc_id: str, rev: int, lineage: str, q_epoch: int, html: str) -> str:
    """Make a render at `rev` the readable copy if it holds the document then: installed, stale or refused."""
    log_read = read(adapter, doc_id, integrated=True)
    if log_read is None or not renders_log(log_read, rev, lineage, q_epoch):
        return "stale"

    clean = sanitize_html(html)
    text = BeautifulSoup(clean, "html.parser").get_text()
    if not spec_of(adapter).check_copy(state_at(adapter, log_read, rev), clean, text):
        keep_evidence(adapter, doc_id, "copy_refused", clean, rev)
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        db.alert("Collab readable copy: refused", f"{adapter} document {doc_id} at rev {rev}")
        return "refused"

    if not write(adapter, doc_id, rev, clean):
        return "stale"

    return "installed"


def renders_log(log_read: Snapshot, rev: int, lineage: str, q_epoch: int) -> bool:
    """Whether a render at `rev` is of this log as it stands, from no earlier than its base."""
    same_log = lineage == log_read.lineage and q_epoch == log_read.q_epoch
    return same_log and log_read.base <= rev <= log_read.head_rev


def state_at(adapter: str, log_read: Snapshot, rev: int) -> bytes:
    """Return the document at `rev`, from the read's integrated base."""
    rows = [payload for row_rev, payload in log_read.rows if row_rev <= rev]
    if not rows:
        return log_read.checkpoint or pycrdt.Doc().get_update()

    compacted = compaction.compact(log_read.checkpoint, rows, spec_of(adapter).roots)
    if not compacted.integrated:
        raise compaction.CompactionFailed("fallback")

    return compacted.state


def write(adapter: str, doc_id: str, rev: int, html: str) -> bool:
    """T3a: lock the app's row, then the projection row; replace the copy if `rev` is newer than it."""
    spec = spec_of(adapter)
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    app_row = locked_app_row(adapter, doc_id)
    if app_row is None:
        frappe.db.rollback()
        return False

    projection = locked_projection(adapter, doc_id)
    if int(projection.projected_rev) >= rev:
        frappe.db.rollback()
        return False

    is_foreign = keep_unprojected(adapter, doc_id, app_row.written or "", projection.projection_hash)
    project(adapter, doc_id, app_row.name, rev, html)
    keep_copy(adapter, doc_id, rev, html)
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    frappe.clear_document_cache(spec.content_type, app_row.name)
    if is_foreign:
        db.alert("Collab readable copy: written elsewhere", f"{adapter} document {doc_id}, kept as evidence")

    return True


def project(adapter: str, doc_id: str, docname: str, rev: int, html: str) -> None:
    """Write `html` to the app's copy field and record it as the copy at `rev`."""
    spec = spec_of(adapter)
    projection_table = table(adapter, "projection")
    frappe.db.sql(
        f"UPDATE `tab{spec.content_type}` SET `{spec.copy_field}` = %s WHERE `name` = %s", (html, docname)
    )
    frappe.db.sql(
        f"""UPDATE `{projection_table}` SET `projected_rev` = %s, `projection_hash` = UNHEX(%s),
        `updated` = %s WHERE `doc_id` = %s""",
        (rev, sha_of(html), now_datetime(), doc_id),
    )


def locked_app_row(adapter: str, doc_id: str) -> frappe._dict | None:
    """Lock and return the app's row of a log that isn't purged, its copy field as `written`."""
    spec = spec_of(adapter)
    doc_table = table(adapter, "doc")
    found = frappe.db.sql(
        f"""SELECT `app`.`name`, `app`.`{spec.copy_field}` AS `written` FROM `tab{spec.content_type}` `app`
        JOIN `{doc_table}` `doc` ON `app`.`{spec.node_field}` = `doc`.`node`
        WHERE `doc`.`id` = %s AND `doc`.`mode` != 'purged' ORDER BY `app`.`name` LIMIT 1 FOR UPDATE""",
        doc_id,
        as_dict=True,
    )
    if not found:
        return None

    return found[0]


def locked_projection(adapter: str, doc_id: str) -> frappe._dict:
    """Lock and return the log's projection row, made at rev 0 if it has none."""
    projection_table = table(adapter, "projection")
    frappe.db.sql(f"INSERT IGNORE INTO `{projection_table}` (`doc_id`) VALUES (%s)", doc_id)
    (projection,) = frappe.db.sql(
        f"SELECT `projected_rev`, `projection_hash` FROM `{projection_table}` WHERE `doc_id` = %s FOR UPDATE",
        doc_id,
        as_dict=True,
    )
    return projection


def keep_unprojected(adapter: str, doc_id: str, written: str, projection_hash: bytes | None) -> bool:
    """Keep what the field holds if no copy put it there; answers whether something else wrote over a copy."""
    if projection_hash is None:
        # The body from before the log, kept quietly
        if written:
            keep_evidence(adapter, doc_id, "copy_first", written, None)

        return False

    if sha_of(written) == bytes(projection_hash).hex():
        return False

    keep_evidence(adapter, doc_id, "copy_foreign", written, None)
    return True


def keep_copy(adapter: str, doc_id: str, rev: int, html: str) -> None:
    """Keep the copy at `rev` and drop older ones no version holds."""
    copy_table = table(adapter, "copy")
    frappe.db.sql(
        f"""INSERT INTO `{copy_table}` (`doc_id`, `rev`, `html`, `created`) VALUES (%s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE `html` = VALUES(`html`)""",
        (doc_id, rev, html, now_datetime()),
    )
    frappe.db.sql(
        f"DELETE FROM `{copy_table}` WHERE `doc_id` = %s AND `rev` < %s AND (`held` = 0 OR `html` IS NULL)",
        (doc_id, rev),
    )


def keep_evidence(adapter: str, doc_id: str, reason: str, html: str, rev: int | None) -> None:
    """Keep `html` in the recovery table for no writer; the same bytes are kept once."""
    doc_table = table(adapter, "doc")
    recovery_table = table(adapter, "recovery")
    payload = html.encode()
    try:
        frappe.db.sql(
            f"""INSERT INTO `{recovery_table}`
            (`id`, `doc_id`, `node`, `owner`, `reason`, `lineage`, `sha256`, `nbytes`, `payload`, `context_rev`, `created`)
            SELECT %s, `id`, `node`, 'system', %s, `lineage`, UNHEX(%s), %s, UNHEX(%s), %s, %s
            FROM `{doc_table}` WHERE `id` = %s""",
            (
                frappe.generate_hash(length=20),
                reason,
                sha_of(html),
                len(payload),
                payload.hex(),
                rev,
                now_datetime(),
                doc_id,
            ),
        )
    except Exception as error:
        if not frappe.db.is_duplicate_entry(error):
            raise


def sha_of(html: str) -> str:
    """Return the sha256 of `html` as UTF-8, in hex."""
    return hashlib.sha256(html.encode()).hexdigest()
