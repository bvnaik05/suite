import frappe
from frappe.tests import IntegrationTestCase

from suite.content import log
from suite.writer.content import APP, turn_on
from suite.writer.patches import turn_collaboration_on


def rows() -> list[tuple[str, str]]:
    return [
        (row.app, row.mode)
        for row in frappe.get_all(
            "Suite Collab App",
            filters={"parent": "Suite Collab Settings", "parentfield": "apps"},
            fields=["app", "mode"],
            order_by="idx",
        )
    ]


def remove_writers_row() -> None:
    # Straight from the table, since saving Settings refuses it
    frappe.db.delete("Suite Collab App", {"parent": "Suite Collab Settings", "app": APP})


class TestWriterSwitch(IntegrationTestCase):
    """Writer's collaboration is turned on at install and migrate, and then stays on."""

    def test_turning_on_adds_writers_row_when_it_has_none(self):
        remove_writers_row()
        self.assertEqual(log.mode(APP), "off")

        turn_on()

        self.assertEqual(log.mode(APP), "on")

    def test_the_patch_run_twice_leaves_one_writer_row_on_and_other_apps_alone(self):
        others = [row for row in rows() if row[0] != APP]
        remove_writers_row()

        turn_collaboration_on.execute()
        turn_collaboration_on.execute()

        self.assertEqual([row for row in rows() if row[0] == APP], [(APP, "on")])
        self.assertEqual([row for row in rows() if row[0] != APP], others)

    def test_writer_cannot_be_turned_off_or_removed(self):
        turn_on()

        with self.assertRaisesRegex(frappe.ValidationError, f"Collaboration in {APP} can't be turned off"):
            log.set_mode(APP, "off")

        settings = frappe.get_single("Suite Collab Settings")
        settings.apps = [row for row in settings.apps if row.app != APP]
        with self.assertRaisesRegex(frappe.ValidationError, f"Collaboration in {APP} can't be turned off"):
            settings.save(ignore_permissions=True)

        self.assertEqual(log.mode(APP), "on")
