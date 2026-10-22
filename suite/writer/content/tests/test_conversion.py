import base64
import dataclasses
import json
import os
from unittest.mock import patch

import frappe
import pycrdt
from bs4 import BeautifulSoup
from frappe.utils import get_datetime, get_system_timezone

from suite import drive
from suite.content import checker, compaction, convert, copies, log
from suite.content.http import routes
from suite.drive._core.principals import Principals
from suite.drive._core.versions import read_version
from suite.drive.patches.build.content_mapping import derived_name, epoch_millis
from suite.writer import content as writer_content
from suite.writer.content import conversion
from suite.writer.content.readable_copy import is_html_complete
from suite.writer.content.tests.drive_callback_case import DriveCallbackCase
from suite.writer.content.tests.support import WRITER, call_route, read_open

TIME = 1_690_000_000_000
OLD_THREAD = {"uuid": "u1", "comments": [{"userName": "Ann", "time": TIME, "content": "Old note"}]}
REAL_CONVERT = convert.convert


def old_comments(*comments: tuple[str, str, list[str]]) -> str:
    doc = pycrdt.Doc()
    listed = doc.get("comments", type=pycrdt.Map)
    for key, words, replies in comments:
        listed[key] = {"id": key, "anchorText": words, "replies": [{"id": reply} for reply in replies]}

    return base64.b64encode(doc.get_update()).decode()


def renamed(node: str, source_id: str) -> str:
    return derived_name("drive-comment-rename/1", node, source_id)


class TestConversion(DriveCallbackCase):
    def setUp(self):
        super().setUp()
        if not checker.usable_node(convert.NODE_MIN) or not writer_content.CONVERTER_BUILD.is_file():
            reason = f"needs Node and the built bundle at {writer_content.CONVERTER_BUILD}; run bench build"
            if os.environ.get("CI"):
                self.fail(reason)

            self.skipTest(reason)

        job_patch = patch.object(frappe.local, "job", frappe._dict(job_name="test_conversion"), create=True)
        job_patch.start()
        self.addCleanup(job_patch.stop)

    def old_document(self, html: str | None, ycomments: str | None = None) -> str:
        node = self.new_document()
        self.delete_log(node)
        old = {"content": None, "html": html, "collab": 0, "ycomments": ycomments}
        frappe.db.set_value("Writer Document", self.docname_of(node), old, update_modified=False)
        frappe.db.commit()
        return node

    def build_thread(self, node: str, name: str, comments: list[str]) -> None:
        thread = frappe.get_doc({"doctype": "Drive Comment Thread", "node": node, "anchor": name})
        thread.name = name
        thread.db_insert()
        for index, name in enumerate(comments, 1):
            row = {"thread": thread.name, "node": node, "content": "Kept", "author": WRITER, "idx": index}
            comment = frappe.get_doc({"doctype": "Drive Comment", **row, "author_name": "Kept"})
            comment.name = name
            comment.db_insert()

        frappe.db.commit()

    def records(self, node: str) -> list[tuple]:
        return frappe.db.sql(
            "SELECT `outcome`, `reason`, `dropped` FROM `__writer_content_conversion` WHERE `node` = %s", node
        )

    def threads_of(self, node: str) -> list[frappe._dict]:
        return frappe.get_all("Drive Comment Thread", {"node": node}, ["name", "anchor"], order_by="name")

    def as_before(self, node: str) -> dict:
        docname = self.docname_of(node)
        return {
            "row": frappe.db.get_value("Writer Document", docname, conversion.FIELDS, as_dict=True),
            "threads": self.threads_of(node),
            "versions": frappe.db.count("Drive Node Version", {"node": node}),
            "log": log.find(writer_content.APP, node),
            "evidence": frappe.db.count("__writer_content_recovery", {"node": node}),
        }

    def before_collaboration(self, node: str) -> dict:
        filters = {"node": node, "kind": "milestone", "label": "Before collaboration"}
        [seq] = frappe.get_all("Drive Node Version", filters, pluck="seq")
        owner = Principals(WRITER, (WRITER, "$GENERAL"), ("$PUBLIC",))
        with read_version(owner, node, seq) as stream:
            return json.loads(stream.read())

    def started_state(self, node: str) -> bytes:
        return read_open(call_route(routes.document_get, node).get_data()).checkpoint

    def text_of_log(self, node: str) -> str:
        doc = pycrdt.Doc()
        doc.apply_update(self.started_state(node))
        return str(doc.get("default", type=pycrdt.XmlFragment))

    def test_converts_an_old_document_and_keeps_its_body_as_a_version(self):
        node = self.old_document("<p>Hello world</p>")

        self.assertEqual(conversion.convert_document(node), "converted")

        old = {"schema": "writer-document/1", "content": "AAA=", "html": "<p>Hello world</p>", "collab": 0}
        self.assertEqual(self.before_collaboration(node), old)
        self.assertEqual(self.text_of_log(node), "<paragraph>Hello world</paragraph>")
        row = frappe.db.get_value(
            "Writer Document", self.docname_of(node), ["html", "ycomments"], as_dict=True
        )
        self.assertIn("Hello world", row.html)
        text = BeautifulSoup(row.html, "html.parser").get_text()
        self.assertTrue(is_html_complete(self.started_state(node), row.html, text))
        self.assertEqual(self.records(node), (("converted", None, "[]"),))

    def test_converts_an_empty_document_into_an_empty_copy(self):
        node = self.old_document(None)

        self.assertEqual(conversion.convert_document(node), "converted")

        old = {"schema": "writer-document/1", "content": "AAA=", "html": "", "collab": 0}
        self.assertEqual(self.before_collaboration(node), old)
        html = frappe.db.get_value("Writer Document", self.docname_of(node), "html")
        self.assertEqual(BeautifulSoup(html, "html.parser").get_text(), "")

    def test_anchors_each_old_comment_on_the_drive_thread_build_made_for_it(self):
        for name, thread in (("kept", lambda node, id_: id_), ("renamed", renamed)):
            with self.subTest(name):
                node = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", ["r1"])))
                self.build_thread(node, thread(node, "c1"), [thread(node, "c1"), thread(node, "r1")])

                self.assertEqual(conversion.convert_document(node), "converted")

                [stored] = self.threads_of(node)
                self.assertEqual(stored.name, thread(node, "c1"))
                self.assertEqual(json.loads(stored.anchor)["q"], "world")
                self.assertIsNone(frappe.db.get_value("Writer Document", self.docname_of(node), "ycomments"))
                self.assertEqual(self.records(node), (("converted", None, "[]"),))

    def test_names_a_renamed_thread_as_build_does(self):
        self.assertEqual(conversion.renamed_id("node-b", "top"), renamed("node-b", "top"))

    def test_installs_a_2023_thread_once_at_its_own_time_telling_no_one(self):
        data = json.dumps(OLD_THREAD)
        html = f"<p>Hello <span data-comment='{data}'>old</span> world</p>"
        node = self.old_document(html)
        notifications = frappe.db.count("Drive Notification")

        self.assertEqual(conversion.convert_document(node), "converted")
        self.assertEqual(conversion.convert_document(node), "logged")

        [thread] = self.threads_of(node)
        self.assertEqual(json.loads(thread.anchor)["q"], "old")
        fields = ["content", "author_name", "creation"]
        [comment] = frappe.get_all("Drive Comment", {"thread": thread.name}, fields)
        stamp = get_datetime(epoch_millis(TIME, get_system_timezone()))
        self.assertEqual((comment.content, comment.author_name, comment.creation), ("Old note", "Ann", stamp))
        self.assertEqual(frappe.db.count("Drive Notification"), notifications)
        self.assertEqual(frappe.db.count("Drive Node Version", {"node": node, "kind": "milestone"}), 1)

    def test_refuses_an_old_comment_or_reply_no_drive_thread_holds(self):
        for name, held in (("comment", []), ("reply", ["c1"])):
            node = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", ["r1"])))
            if held:
                self.build_thread(node, "c1", held)

            before = self.as_before(node)

            self.assertEqual(conversion.convert_document(node), "check", msg=name)

            self.assertEqual(self.as_before(node), before, msg=name)
            self.assertEqual(self.records(node), (("check", "orphan", None),), msg=name)

    def test_refuses_a_comment_mark_no_old_comment_lists(self):
        node = self.old_document('<p>Hello <span data-comment-id="m1">world</span></p>')
        before = self.as_before(node)

        self.assertEqual(conversion.convert_document(node), "check")

        self.assertEqual(self.as_before(node), before)
        self.assertEqual(self.records(node), (("check", "orphan", None),))

    def test_refuses_an_old_reply_with_no_id(self):
        doc = pycrdt.Doc()
        doc.get("comments", type=pycrdt.Map)["c1"] = {"id": "c1", "anchorText": "world", "replies": [{}]}
        node = self.old_document("<p>Hello world</p>", base64.b64encode(doc.get_update()).decode())
        self.build_thread(node, "c1", ["c1"])
        before = self.as_before(node)

        self.assertEqual(conversion.convert_document(node), "check")

        self.assertEqual(self.as_before(node), before)
        self.assertEqual(self.records(node), (("check", "comments", None),))

    def test_records_a_drive_thread_no_old_comment_names(self):
        node = self.old_document("<p>Hello world</p>")
        self.build_thread(node, "x1", ["x1"])

        self.assertEqual(conversion.convert_document(node), "converted")

        self.assertEqual([thread.anchor for thread in self.threads_of(node)], ["x1"])
        [(_outcome, _reason, dropped)] = self.records(node)
        self.assertEqual(json.loads(dropped), [{"kind": "unknown-anchor", "thread": "x1"}])

    def edit_while_converting(self, node: str, edits: int):
        docname = self.docname_of(node)
        calls: list[int] = []

        def edited(*args, **kwargs):
            converted = REAL_CONVERT(*args, **kwargs)
            calls.append(1)
            edit = len(calls)
            if edit <= edits:
                frappe.db.set_value("Writer Document", docname, "html", f"<p>Edit {edit}</p>")
                frappe.db.commit()

            return converted

        return patch.object(convert, "convert", side_effect=edited)

    def test_reads_a_row_again_when_it_changes_under_the_converter(self):
        node = self.old_document("<p>Hello world</p>")

        with self.edit_while_converting(node, edits=1):
            self.assertEqual(conversion.convert_document(node), "converted")

        self.assertEqual(self.before_collaboration(node)["html"], "<p>Edit 1</p>")
        self.assertEqual(self.text_of_log(node), "<paragraph>Edit 1</paragraph>")

    def test_leaves_a_row_that_keeps_changing_to_the_next_run(self):
        node = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", [])))
        self.build_thread(node, "c1", ["c1"])

        with self.edit_while_converting(node, edits=conversion.ATTEMPTS):
            self.assertIsNone(conversion.convert_document(node))

        after = self.as_before(node)
        self.assertEqual(after["row"]["html"], f"<p>Edit {conversion.ATTEMPTS}</p>")
        self.assertEqual(
            (after["threads"], after["versions"], after["log"]), (self.threads_of(node), 0, None)
        )
        self.assertEqual(self.records(node), ())

    def test_a_refusal_at_any_step_writes_only_its_record(self):
        def converted_with(**changes):
            return lambda *args, **kwargs: dataclasses.replace(REAL_CONVERT(*args, **kwargs), **changes)

        failed = compaction.CompactionFailed("unreadable")
        fallback = compaction.Compacted(b"", integrated=False)
        for name, target, attribute, stub, refusal in (
            (
                "over quota",
                drive,
                "take_version",
                {"side_effect": drive.DriveOverQuota()},
                ("over_quota", None),
            ),
            ("checker failed", compaction, "compact", {"side_effect": failed}, ("check", "unreadable")),
            ("checker fallback", compaction, "compact", {"return_value": fallback}, ("check", "fallback")),
            ("copy missing", writer_content, "is_html_complete", {"return_value": False}, ("check", "copy")),
            ("copy not written", copies, "replace_copy", {"return_value": None}, ("check", "copy")),
            (
                "copy emptied",
                convert,
                "convert",
                {"side_effect": converted_with(html="")},
                ("check", "empty"),
            ),
            (
                "converter",
                convert,
                "convert",
                {"return_value": convert.Refused("too_large")},
                ("too_large", None),
            ),
        ):
            key = name.replace(" ", "-")
            node = self.old_document("<p>Hello world</p>", old_comments((key, "world", [])))
            self.build_thread(node, key, [key])
            before = self.as_before(node)

            with patch.object(target, attribute, **stub):
                self.assertEqual(conversion.convert_document(node), refusal[0], msg=name)

            self.assertEqual(self.as_before(node), before, msg=name)
            self.assertEqual(self.records(node), ((*refusal, None),), msg=name)

    def test_a_failure_after_the_first_write_keeps_the_old_comments(self):
        node = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", [])))
        self.build_thread(node, "c1", ["c1"])
        before = self.as_before(node)

        with (
            patch.object(drive, "install_threads", side_effect=RuntimeError("down")),
            self.assertRaises(RuntimeError),
        ):
            conversion.convert_document(node)

        self.assertEqual(self.as_before(node), before)
        self.assertEqual(self.records(node), ())

    def test_leaves_a_document_purged_under_the_converter(self):
        node = self.old_document("<p>Hello world</p>")

        def purged(*args, **kwargs):
            self.delete_document(node)
            return REAL_CONVERT(*args, **kwargs)

        with patch.object(convert, "convert", side_effect=purged):
            self.assertIsNone(conversion.convert_document(node))

        self.assertEqual(self.records(node), ())

    def test_keeps_a_record_for_each_body_it_refuses(self):
        node = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", [])))
        self.assertEqual(conversion.convert_document(node), "check")
        frappe.db.set_value("Writer Document", self.docname_of(node), "html", "<p>Hello again</p>")
        frappe.db.commit()

        self.assertEqual(conversion.convert_document(node), "check")

        self.assertEqual(len(self.records(node)), 2)

    def test_a_purge_leaves_no_record_of_a_converted_or_refused_document(self):
        converted = self.old_document("<p>Hello world</p>")
        refused = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", [])))
        for node in (converted, refused):
            conversion.convert_document(node)
            self.assertEqual(len(self.records(node)), 1)

            self.delete_document(node)

            self.assertEqual(self.records(node), ())
