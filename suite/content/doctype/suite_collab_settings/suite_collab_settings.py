import frappe
from frappe import _
from frappe.model.document import Document

from suite.content.editors import editors


class SuiteCollabSettings(Document):
    def validate(self):
        known = editors()
        seen: set[str] = set()
        for row in self.apps:
            if row.app not in known:
                frappe.throw(_("No app named {0} keeps its documents in the content layer").format(row.app))

            if row.app in seen:
                frappe.throw(_("{0} has more than one row").format(row.app))

            seen.add(row.app)
