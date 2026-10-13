import hashlib

import frappe

from suite.suite_core.content import copies
from suite.writer import content as writer_content
from suite.writer.content.tests.support import CheckpointCase


class TestReadableCopies(CheckpointCase):
    """A tab's render of the document becomes its readable copy only when it holds the document at its rev."""

    def setUp(self):
        super().setUp()
        self.node = self.new_document()
        self.type_into(self.node, ["one", " two"])
        self.doc = self.doc_row(self.node)

    def install(self, rev: int, html: str, **render) -> str:
        fields = {"lineage": self.doc.lineage, "q_epoch": int(self.doc.q_epoch), **render}
        return copies.install(writer_content.ADAPTER, self.doc.id, rev, html=html, **fields)

    def copy_field(self) -> str:
        return frappe.db.get_value("Writer Document", {"node": self.node}, "html") or ""

    def evidence(self) -> list[tuple[str, str, bytes]]:
        rows = frappe.db.sql(
            """SELECT `owner`, `reason`, `payload` FROM `__writer_content_recovery`
            WHERE `doc_id` = %s ORDER BY `created`, `reason`""",
            self.doc.id,
        )
        return [(owner, reason, bytes(payload)) for owner, reason, payload in rows]

    def kept_copies(self) -> list[tuple[int, str | None, int]]:
        rows = frappe.db.sql(
            "SELECT `rev`, `html`, `held` FROM `__writer_content_copy` WHERE `doc_id` = %s ORDER BY `rev`",
            self.doc.id,
        )
        return [(int(rev), html, int(held)) for rev, html, held in rows]

    def alerts(self) -> int:
        return frappe.db.count("Error Log", {"method": ["like", "Collab readable copy%"]})

    def test_a_render_of_the_head_becomes_the_documents_copy(self):
        self.assertEqual(self.install(2, "<p>one two</p>"), "installed")

        self.assertEqual(self.copy_field(), "<p>one two</p>")
        self.assertEqual(self.kept_copies(), [(2, "<p>one two</p>", 0)])

    def test_a_render_is_checked_against_the_document_at_its_own_rev(self):
        self.assertEqual(self.install(1, "<p>one</p>"), "installed")
        self.assertEqual(self.copy_field(), "<p>one</p>")

        self.assertEqual(self.install(2, "<p>one</p>"), "refused")
        self.assertEqual(self.copy_field(), "<p>one</p>")

    def test_the_copy_only_moves_forward(self):
        self.install(2, "<p>one two</p>")

        self.assertEqual(self.install(1, "<p>one</p>"), "stale")
        self.assertEqual(self.install(2, "<p>one two!</p>"), "stale")
        self.assertEqual(self.copy_field(), "<p>one two</p>")

    def test_a_render_of_another_log_or_from_before_a_quarantine_is_stale(self):
        stale_renders = [
            {"lineage": "0" * 32},
            {"q_epoch": int(self.doc.q_epoch) + 1},
        ]
        for render in stale_renders:
            with self.subTest(render=render):
                self.assertEqual(self.install(2, "<p>one two</p>", **render), "stale")

        self.assertEqual(self.install(3, "<p>one two</p>"), "stale")
        self.assertEqual(self.copy_field(), "")

    def test_a_render_missing_text_is_kept_as_evidence_and_never_published(self):
        alerts = self.alerts()

        self.assertEqual(self.install(2, "<p>one</p>"), "refused")

        self.assertEqual(self.copy_field(), "")
        self.assertEqual(self.evidence(), [("system", "copy_refused", b"<p>one</p>")])
        self.assertEqual(self.alerts(), alerts + 1)

    def test_markup_a_browser_would_run_is_taken_out_before_the_copy_is_published(self):
        self.install(2, '<p onclick="steal()">one two</p><script>steal()</script>')

        self.assertEqual(self.copy_field(), "<p>one two</p>")

    def test_a_body_from_before_the_log_is_kept_quietly_when_the_first_copy_replaces_it(self):
        frappe.db.set_value(
            "Writer Document", {"node": self.node}, "html", "<p>legacy</p>", update_modified=False
        )
        frappe.db.commit()
        alerts = self.alerts()

        self.install(2, "<p>one two</p>")

        self.assertEqual(self.evidence(), [("system", "copy_first", b"<p>legacy</p>")])
        self.assertEqual(self.alerts(), alerts)

    def test_a_copy_written_over_by_something_else_is_kept_as_evidence_and_alerted(self):
        self.install(1, "<p>one</p>")
        frappe.db.set_value(
            "Writer Document", {"node": self.node}, "html", "<p>foreign</p>", update_modified=False
        )
        frappe.db.commit()
        alerts = self.alerts()

        self.assertEqual(self.install(2, "<p>one two</p>"), "installed")

        self.assertEqual(self.copy_field(), "<p>one two</p>")
        self.assertEqual(self.evidence(), [("system", "copy_foreign", b"<p>foreign</p>")])
        self.assertEqual(self.alerts(), alerts + 1)

    def test_older_copies_are_dropped_unless_a_version_holds_them(self):
        self.install(1, "<p>one</p>")
        frappe.db.sql("UPDATE `__writer_content_copy` SET `held` = 1 WHERE `doc_id` = %s", self.doc.id)
        frappe.db.commit()

        self.install(2, "<p>one two</p>")

        self.assertEqual(self.kept_copies(), [(1, "<p>one</p>", 1), (2, "<p>one two</p>", 0)])
        ((stored_hash,),) = frappe.db.sql(
            "SELECT `projection_hash` FROM `__writer_content_projection` WHERE `doc_id` = %s", self.doc.id
        )
        self.assertEqual(bytes(stored_hash), hashlib.sha256(b"<p>one two</p>").digest())
