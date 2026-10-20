import base64
import hashlib
import json
import struct
import uuid
from unittest.mock import patch

import frappe
import pycrdt
from frappe.tests import IntegrationTestCase

from suite import content
from suite.content import capacity, jobs, log
from suite.content.editors import editors
from suite.content.tables import KINDS, ensure_tables, table
from suite.content.tests import note
from suite.drive._core.content import clear_registry_cache

APP_TABLE = f"tab{note.EDITOR.doctype}"
OWNED = (APP_TABLE, *(table(note.EDITOR.app, kind) for kind in KINDS))
NOTE_HOOK = "suite.content.tests.note.EDITOR"
DRIVE_HOOK = "suite.content.tests.note.SPEC"


def typed(client_id: int, text: str) -> bytes:
    doc = pycrdt.Doc(client_id=client_id)
    doc.get("text", type=pycrdt.Text).insert(0, text)
    return doc.get_update()


def drop_owned_tables() -> None:
    for name in OWNED:
        frappe.db.sql_ddl(f"DROP TABLE IF EXISTS `{name}`")


def text_of(state: bytes) -> str:
    doc = pycrdt.Doc()
    doc.apply_update(state)
    return str(doc.get("text", type=pycrdt.Text))


class TestNoteEditor(IntegrationTestCase):
    """An app with no product code keeps its documents in the layer, under its own declarations and switch."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        real = frappe.get_hooks
        added = {"suite_content_editors": NOTE_HOOK, "drive_content_types": DRIVE_HOOK}

        def get_hooks(hook=None, *args, **kwargs):
            found = real(hook, *args, **kwargs)
            if hook in added:
                return [*found, added[hook]]

            return found

        # The apps the site ships, each switched back as it was
        cls.others = {name: log.mode(name) for name in editors()}
        cls.addClassCleanup(clear_registry_cache)
        cls.hooks = patch.object(frappe, "get_hooks", get_hooks)
        cls.hooks.start()
        cls.addClassCleanup(cls.hooks.stop)
        clear_registry_cache()
        # Cleanup drops these, so a site that already has any of them is refused before anything is made
        taken = frappe.db.sql(
            "SELECT `table_name` FROM information_schema.tables WHERE `table_schema` = DATABASE() AND `table_name` IN %s",
            [OWNED],
        )
        if taken:
            raise RuntimeError(f"The note app's tables already exist: {taken}")

        cls.addClassCleanup(drop_owned_tables)
        frappe.db.sql_ddl(
            f"""CREATE TABLE `{APP_TABLE}` (`name` varchar(140) NOT NULL, `node` varchar(140),
            `body` longtext, `html` longtext, `modified` datetime(6), PRIMARY KEY (`name`))"""
        )
        ensure_tables(note.EDITOR.app)

    @classmethod
    def tearDownClass(cls):
        settings = frappe.get_single("Suite Collab Settings")
        settings.apps = [row for row in settings.apps if row.app != note.EDITOR.app]
        settings.save(ignore_permissions=True)
        for name, mode in cls.others.items():
            log.set_mode(name, mode)
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        super().tearDownClass()

    def setUp(self):
        log.set_mode(note.EDITOR.app, "on")
        self.node = frappe.generate_hash(length=10)
        frappe.db.sql(
            f"INSERT INTO `{APP_TABLE}` (`name`, `node`, `body`) VALUES (%s, %s, '')", (self.node, self.node)
        )
        self.doc_id = log.create(note.EDITOR.app, self.node)
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
        self.sid = uuid.uuid4().hex
        self.client_id = content.issue_session(note.EDITOR.app, self.doc_id, self.sid, "Administrator")

    def push(self, payload: bytes) -> dict:
        lineage = content.find(note.EDITOR.app, self.node).lineage
        fields = {
            "lineage": lineage,
            "sid": self.sid,
            "from": 1,
            "to": 1,
            "cid": self.client_id,
            "seen_rev": 0,
            "schema": 1,
            "shas": [hashlib.sha256(payload).hexdigest()],
        }
        encoded = json.dumps(fields).encode()
        header, body = content.parse_push(struct.pack(">I", len(encoded)) + encoded + payload)
        return content.push(note.EDITOR.app, self.doc_id, header, body, "Administrator")

    def test_a_note_takes_a_push_and_reads_back_as_written(self):
        self.assertEqual(self.push(typed(self.client_id, "hello"))["rev"], 1)

        rows = content.read(note.EDITOR.app, self.doc_id).rows
        doc = pycrdt.Doc()
        for _rev, payload in rows:
            doc.apply_update(payload)
        self.assertEqual(str(doc.get("text", type=pycrdt.Text)), "hello")

    def test_compaction_writes_a_note_body_into_the_apps_own_row(self):
        self.push(typed(self.client_id, "kept"))

        jobs.compact(note.EDITOR.app, self.doc_id)

        body = frappe.db.sql(f"SELECT `body` FROM `{APP_TABLE}` WHERE `name` = %s", self.node)[0][0]
        self.assertEqual(text_of(base64.b64decode(body)), "kept")

    def test_a_change_over_the_layers_cap_is_malformed(self):
        with patch.object(capacity, "CHANGE_MAX", 2**16), self.assertRaises(content.Refusal) as refused:
            self.push(typed(self.client_id, "x" * (2**16 + 1)))

        self.assertEqual(refused.exception.body, {"collab": "malformed"})

    def test_switching_every_other_app_off_leaves_notes_on(self):
        self.assertTrue(self.others)
        for name in self.others:
            log.set_mode(name, "off")

        self.assertTrue(content.enabled(note.EDITOR.app))
        content.require_enabled(note.EDITOR.app)
        self.assertEqual(self.push(typed(self.client_id, "still here"))["rev"], 1)
        for name in self.others:
            with self.subTest(app=name), self.assertRaises(content.Refusal) as refused:
                content.require_enabled(name)
            self.assertEqual(refused.exception.body, {"collab": "disabled"})
