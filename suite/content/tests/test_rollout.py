import threading
import time
from unittest.mock import MagicMock, patch

import frappe

from suite import drive
from suite.content import conversions, convert, jobs, log
from suite.content.tests import note
from suite.content.tests.test_note import APP_TABLE, NoteAppCase, typed

NOTE_ROW = {"parent": "Suite Collab Settings", "parentfield": "apps", "app": note.EDITOR.app}


def pause_conversion(paused: bool) -> int:
    frappe.db.sql(
        """UPDATE `tabSuite Collab App` SET `conversion_paused` = %s
        WHERE `parent` = %s AND `parentfield` = %s AND `app` = %s""",
        (int(paused), NOTE_ROW["parent"], NOTE_ROW["parentfield"], NOTE_ROW["app"]),
    )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    return frappe.db.get_value("Suite Collab App", NOTE_ROW, "conversion_paused")


class TestRollout(NoteAppCase):
    """Pausing an app's conversion stops new conversions at every place one starts."""

    def setUp(self):
        super().setUp()
        self.addCleanup(pause_conversion, False)

    def old_note(self) -> str:
        node = frappe.generate_hash(length=10)
        frappe.db.sql(
            f"INSERT INTO `{APP_TABLE}` (`name`, `node`, `body`, `html`) VALUES (%s, %s, '', '<p>Old</p>')",
            (node, node),
        )
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        self.addCleanup(self.remove_note, node)
        return node

    def test_a_paused_app_queues_no_conversion(self):
        with patch.object(frappe, "enqueue") as enqueue:
            jobs.queue_conversion()

        self.assertIn(note.EDITOR.app, [call.kwargs["app"] for call in enqueue.call_args_list])

        self.assertEqual(pause_conversion(True), 1)
        with patch.object(frappe, "enqueue") as enqueue:
            jobs.queue_conversion()

        self.assertNotIn(note.EDITOR.app, [call.kwargs["app"] for call in enqueue.call_args_list])

    def test_a_paused_app_runs_no_pending_conversion(self):
        with patch.object(conversions, "run_pending") as run_pending:
            jobs.convert_pending(note.EDITOR.app)

        run_pending.assert_called_once()

        self.assertEqual(pause_conversion(True), 1)
        with patch.object(conversions, "run_pending") as run_pending:
            jobs.convert_pending(note.EDITOR.app)

        run_pending.assert_not_called()

    def test_a_paused_page_leaves_an_old_note_unconverted(self):
        node = self.old_note()
        converted = convert.Converted(
            state=typed(1, "Hello"), source="html", dropped=[], anchors={}, threads=[], html="<p>Hello</p>"
        )
        self.assertEqual(pause_conversion(True), 1)

        with (
            patch.object(convert, "convert", return_value=converted) as converting,
            patch.object(drive, "take_version"),
        ):
            went_on = conversions.convert_page(
                note.EDITOR.app, [frappe._dict(node=node)], time.monotonic() + 60
            )

        self.assertFalse(went_on)
        self.assertIsNone(log.find(note.EDITOR.app, node))
        [[html]] = frappe.db.sql(f"SELECT `html` FROM `{APP_TABLE}` WHERE `name` = %s", node)
        self.assertEqual(html, "<p>Old</p>")
        self.assertFalse(frappe.db.sql("SELECT 1 FROM `__note_content_conversion` WHERE `node` = %s", node))
        converting.assert_not_called()

    def test_a_pause_flipped_mid_page_stops_the_next_document(self):
        site = frappe.local.site
        errors: list[Exception] = []
        stored: list[int] = []

        def pause_elsewhere():
            frappe.init(site=site)
            frappe.connect()
            try:
                stored.append(pause_conversion(True))
            except Exception as error:
                errors.append(error)
            finally:
                frappe.destroy()

        def first_document(app: str, node: str) -> str:
            if convert_document.call_count == 1:
                frappe.db.commit()  # nosemgrep: frappe-manual-commit
                # A plain read opens the snapshot the next document's pause read sees unless it is current
                self.assertEqual(frappe.db.get_value("Suite Collab App", NOTE_ROW, "conversion_paused"), 0)
                admin = threading.Thread(target=pause_elsewhere)
                admin.start()
                admin.join(30)
                self.assertFalse(admin.is_alive())

            return "converted"

        convert_document = MagicMock(side_effect=first_document)
        page = [frappe._dict(node=frappe.generate_hash(length=10)) for _ in range(2)]

        with patch.object(conversions, "convert_document", convert_document):
            went_on = conversions.convert_page(note.EDITOR.app, page, time.monotonic() + 60)

        self.assertEqual((errors, stored), ([], [1]))
        self.assertEqual(convert_document.call_count, 1)
        self.assertFalse(went_on)

    def test_a_paused_backlog_is_not_waiting(self):
        with (
            patch.object(convert, "editors", return_value={note.EDITOR.app: note.EDITOR}),
            patch.object(convert, "pending_page", return_value=[frappe._dict(node="waiting")]),
        ):
            self.assertTrue(convert.any_waiting())
            self.assertEqual(pause_conversion(True), 1)

            self.assertFalse(convert.any_waiting())
