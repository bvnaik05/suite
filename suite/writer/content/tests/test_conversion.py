import base64
import dataclasses
import json
import os
import threading
from datetime import timedelta
from unittest.mock import patch

import frappe
import pycrdt
from bs4 import BeautifulSoup
from frappe.utils import get_datetime, get_system_timezone

from suite import drive
from suite.content import checker, compaction, convert, copies, jobs, log
from suite.content.editors import spec_of
from suite.content.http import routes
from suite.drive._core.nodes import _restore, _trash
from suite.drive._core.principals import Principals
from suite.drive._core.versions import read_version
from suite.drive.patches.build.content_mapping import derived_name, epoch_millis
from suite.writer import content as writer_content
from suite.writer.api import docs
from suite.writer.content import conversion
from suite.writer.content.readable_copy import is_html_complete
from suite.writer.content.tests.drive_callback_case import DriveCallbackCase
from suite.writer.content.tests.support import WRITER, call_route, read_open
from suite.writer.http import routes as writer_routes

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
        kept = frappe.db.sql(
            "SELECT `reason`, `payload` FROM `__writer_content_recovery` WHERE `node` = %s", node
        )
        self.assertEqual(
            [(reason, bytes(payload)) for reason, payload in kept], [("copy_first", b"<p>Hello world</p>")]
        )

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

    def test_records_a_drive_thread_made_while_the_conversion_writes(self):
        node = self.old_document("<p>Hello world</p>")
        site = frappe.local.site
        errors: list[Exception] = []

        def comment_elsewhere():
            frappe.init(site=site)
            frappe.connect()
            frappe.set_user(WRITER)
            try:
                self.build_thread(node, "late", ["late"])
            except Exception as error:
                errors.append(error)
            finally:
                frappe.destroy()

        commenter = threading.Thread(target=comment_elsewhere)
        converted = False
        real_sql = frappe.db.sql

        def converting(*args, **kwargs):
            nonlocal converted
            converted = True
            return REAL_CONVERT(*args, **kwargs)

        # Comment from another connection just before the write first locks a Drive Node
        def sql(query, *args, **kwargs):
            locks_a_node = "`tabDrive Node`" in str(query) and "FOR UPDATE" in str(query).upper()
            if converted and locks_a_node and commenter.ident is None:
                commenter.start()
                commenter.join(10)

            return real_sql(query, *args, **kwargs)

        with patch.object(convert, "convert", side_effect=converting), patch.object(frappe.db, "sql", sql):
            self.assertEqual(conversion.convert_document(node), "converted")

        self.assertIsNotNone(commenter.ident)
        self.assertFalse(commenter.is_alive())
        self.assertEqual(errors, [])
        [(_outcome, _reason, dropped)] = self.records(node)
        self.assertEqual(json.loads(dropped), [{"kind": "unknown-anchor", "thread": "late"}])

    def test_converts_a_collaborative_version_from_its_yjs_body_not_its_stale_html(self):
        node = self.new_document()
        self.delete_log(node)
        doc = pycrdt.Doc()
        doc.get("default", type=pycrdt.XmlFragment).children.append(
            pycrdt.XmlElement("paragraph", None, [pycrdt.XmlText("Yjs text")])
        )
        old = {"content": base64.b64encode(doc.get_update()).decode(), "html": "<p>stale</p>", "collab": 1}
        frappe.db.set_value("Writer Document", self.docname_of(node), old)
        frappe.db.commit()
        seq = drive.take_version(node)
        frappe.db.commit()

        answer = docs.convert_version(node, seq)

        restored = pycrdt.Doc()
        restored.apply_update(base64.b64decode(answer["state"]))
        body = str(restored.get("default", type=pycrdt.XmlFragment))
        self.assertEqual(body, "<paragraph>Yjs text</paragraph>")

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

    def test_tells_the_reader_an_old_document_waits_for_the_converter(self):
        node = self.old_document("<p>Hello world</p>")

        self.assertEqual(writer_routes.document(self.docname_of(node))["conversion"], {"state": "pending"})

    def test_gives_the_reason_for_a_refusal_only_to_a_system_manager(self):
        node = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", [])))
        conversion.convert_document(node)
        docname = self.docname_of(node)

        writer_sees = writer_routes.document(docname)["conversion"]
        frappe.set_user("Administrator")
        manager_sees = writer_routes.document(docname)["conversion"]

        self.assertEqual(writer_sees, {"state": "refused"})
        self.assertEqual(manager_sees, {"state": "refused", "reason": "check: orphan"})

    def test_drops_the_conversion_state_once_converted(self):
        node = self.old_document("<p>Hello world</p>")
        conversion.convert_document(node)

        self.assertNotIn("conversion", writer_routes.document(self.docname_of(node)))

    def test_a_purge_leaves_no_record_of_a_converted_or_refused_document(self):
        converted = self.old_document("<p>Hello world</p>")
        refused = self.old_document("<p>Hello world</p>", old_comments(("c1", "world", [])))
        for node in (converted, refused):
            conversion.convert_document(node)
            self.assertEqual(len(self.records(node)), 1)

            self.delete_document(node)

            self.assertEqual(self.records(node), ())

    def old_documents(self, count: int) -> list[str]:
        nodes = [self.old_document("<p>Hello world</p>") for _ in range(count)]
        for node in nodes:
            self.addCleanup(self.delete_document, node)

        return nodes

    def run_on(self, mine: list[str], each=None) -> list[str]:
        """Run the job, converting only `mine`; the nodes it went to, in order."""
        writer = spec_of(writer_content.APP).conversion
        seen = []

        def only_mine(node):
            seen.append(node)
            if each is not None:
                each(node)

            if node in mine:
                return writer.convert_document(node)

        convert.run_pending(writer_content.APP, dataclasses.replace(writer, convert_document=only_mine))
        return seen

    def reasons_logged(self, reason: str) -> int:
        return frappe.db.count(
            "Error Log", {"method": "Collab conversion: writer did not run", "error": reason}
        )

    def forget_logged(self, reason: str) -> None:
        frappe.cache.delete_value(f"suite-convert-{writer_content.APP}-{reason}")
        self.addCleanup(frappe.cache.delete_value, f"suite-convert-{writer_content.APP}-{reason}")

    def test_a_run_converts_or_records_each_old_document_and_a_second_run_changes_nothing(self):
        good, other, refused = self.old_documents(3)
        frappe.db.set_value(
            "Writer Document", self.docname_of(refused), "ycomments", old_comments(("c1", "world", []))
        )
        frappe.db.commit()

        self.run_on([good, other, refused])

        self.assertEqual(
            [bool(log.find(writer_content.APP, node)) for node in (good, other, refused)], [True, True, False]
        )
        self.assertEqual(self.records(refused), (("check", "orphan", None),))
        after = {node: (self.as_before(node), self.records(node)) for node in (good, other, refused)}

        self.run_on([good, other, refused])

        self.assertEqual({node: (self.as_before(node), self.records(node)) for node in after}, after)

    def test_a_new_converter_version_tries_a_refused_body_again(self):
        [node] = self.old_documents(1)
        with patch.object(convert, "convert", return_value=convert.Refused("too_large")):
            self.assertEqual(conversion.convert_document(node), "too_large")
            self.assertIsNone(conversion.convert_document(node))

            with patch.object(writer_content, "CONVERTER_VERSION", "next"):
                self.assertEqual(conversion.convert_document(node), "too_large")

        self.assertEqual(self.records(node), (("too_large", None, None),) * 2)

    def test_records_a_body_crashed_once_its_attempt_outlives_the_job_and_skips_a_running_one(self):
        running, crashed = self.old_documents(2)
        now = frappe.utils.now_datetime()
        for node, age in (
            (running, timedelta(seconds=60)),
            (crashed, conversion.STALE_ATTEMPT + timedelta(seconds=1)),
        ):
            conversion.start_attempt(node, conversion.read_old(node).fingerprint, now - age)
        before = {node: self.as_before(node) for node in (running, crashed)}

        self.assertIsNone(conversion.convert_document(running))
        self.assertEqual(conversion.convert_document(crashed), "crashed")

        self.assertEqual({node: self.as_before(node) for node in before}, before)
        self.assertEqual(self.records(running), ((None, None, None),))
        self.assertEqual(self.records(crashed), (("crashed", None, None),))

    def test_the_next_run_converts_a_document_made_during_a_run(self):
        [first] = self.old_documents(1)
        made = []

        def make_one(node):
            if node == first and not made:
                made.extend(self.old_documents(1))

        self.run_on([first], each=make_one)
        self.assertIsNone(log.find(writer_content.APP, made[0]))

        self.run_on(made)

        self.assertIsNotNone(log.find(writer_content.APP, made[0]))

    def test_skips_a_trashed_document_and_converts_it_once_restored(self):
        [node] = self.old_documents(1)
        owner = Principals(WRITER, (WRITER, "$GENERAL"), ("$PUBLIC",))
        _trash(owner, node)
        frappe.db.commit()
        before = self.as_before(node)

        self.assertNotIn(node, self.run_on([node]))
        self.assertEqual(self.as_before(node), before)
        self.assertEqual(self.records(node), ())

        _restore(owner, node, parent_node=None)
        frappe.db.commit()
        self.run_on([node])

        self.assertIsNotNone(log.find(writer_content.APP, node))

    def test_goes_through_every_page_newest_first_once(self):
        nodes = self.old_documents(3)

        with patch.object(convert, "PAGE", 2):
            seen = self.run_on([])

        self.assertEqual(seen[:3], nodes[::-1])
        self.assertEqual(len(seen), len(set(seen)))

    def test_starts_no_document_once_its_time_is_up(self):
        [node] = self.old_documents(1)

        with patch.object(convert, "RUN_FOR", -1):
            self.assertEqual(self.run_on([node]), [])

        self.assertIsNone(log.find(writer_content.APP, node))

    def test_stops_and_logs_why_when_the_converter_changes(self):
        reason = "the bundle answered version 9, not 1"
        self.forget_logged(reason)
        logged = self.reasons_logged(reason)

        def changed(node):
            raise convert.ConverterChanged(reason)

        self.assertEqual(len(self.run_on([], each=changed)), 1)
        self.assertEqual(self.reasons_logged(reason), logged + 1)

    def test_without_node_or_the_bundle_writes_nothing_and_logs_once_an_hour(self):
        reason = "no Node, or no converter bundle of this version"
        self.forget_logged(reason)
        logged = self.reasons_logged(reason)
        [node] = self.old_documents(1)

        for stub in ({"return_value": False}, {"side_effect": checker.CheckerFailed("down")}):
            with patch.object(convert, "bundle_ready", **stub):
                self.assertEqual(self.run_on([node]), [])

        self.assertIsNone(log.find(writer_content.APP, node))
        self.assertEqual(self.records(node), ())
        self.assertEqual(self.reasons_logged(reason), logged + 1)

    def test_queues_one_conversion_job_for_each_app_with_a_converter(self):
        writer = spec_of(writer_content.APP)
        apps = {"writer": writer, "plain": dataclasses.replace(writer, conversion=None)}

        with patch.object(jobs, "editors", return_value=apps), patch.object(frappe, "enqueue") as enqueue:
            jobs.queue_conversion()

        [(_, queued)] = [(call.args, call.kwargs) for call in enqueue.call_args_list]
        self.assertEqual((queued["app"], queued["job_id"]), ("writer", "suite-convert-writer"))
