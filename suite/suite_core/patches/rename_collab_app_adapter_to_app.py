import frappe


def execute() -> None:
    """Each Suite Collab App row names its app in `app` now; a row that already has one keeps it."""
    if not frappe.db.has_column("Suite Collab App", "adapter"):
        return

    frappe.db.sql(
        """update `tabSuite Collab App` set `app` = `adapter`
        where coalesce(`app`, '') = '' and coalesce(`adapter`, '') != ''"""
    )
