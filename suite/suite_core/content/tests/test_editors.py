import dataclasses
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from suite.suite_core.content import editors
from suite.suite_core.content.tests import note

HOOK = "suite.suite_core.content.tests.note.SPEC"


def registered(*paths: str):
    real = frappe.get_hooks

    def get_hooks(hook=None, *args, **kwargs):
        return list(paths) if hook == "suite_content_editors" else real(hook, *args, **kwargs)

    return patch.object(frappe, "get_hooks", get_hooks)


def declared(**changes):
    return patch.object(note, "SPEC", dataclasses.replace(note.SPEC, **changes))


class TestEditorDeclarations(UnitTestCase):
    def refusal(self, *paths: str) -> str:
        with registered(*paths), self.assertRaises(ValueError) as refused:
            editors.editors()
        return str(refused.exception)

    def test_an_app_that_declares_everything_is_registered(self):
        with registered(HOOK):
            self.assertEqual(editors.editors(), {"note": note.SPEC})

    def test_an_app_with_no_readable_copy_or_media_is_registered(self):
        with registered(HOOK), declared(readable_copy=None, media=None):
            self.assertIsNone(editors.editors()["note"].readable_copy)

    def test_an_app_with_a_declaration_left_empty_is_refused_naming_the_app_and_the_declaration(self):
        with declared(body_field=None):
            refused = self.refusal(HOOK)

        self.assertIn("(note)", refused)
        self.assertIn("body_field", refused)

    def test_an_app_that_leaves_a_declaration_out_is_refused_naming_its_path(self):
        def construct(path):
            return editors.EditorSpec(app="note")

        with patch.object(frappe, "get_attr", construct):
            refused = self.refusal(HOOK)

        self.assertIn(HOOK, refused)
        self.assertIn("missing", refused)

    def test_each_wrongly_declared_value_is_named(self):
        cases = {
            "app": "Not A Table Name",
            "part_map": {},
            "readable_copy": editors.HtmlCopy(field="", is_html_complete=lambda state, html, text: True),
            "media": editors.MediaReferences(node_ids="not callable", value_rewriter=lambda mapping: str),
        }
        for field, value in cases.items():
            with self.subTest(field=field), declared(**{field: value}):
                self.assertIn(f"declares {field} wrongly", self.refusal(HOOK))

    def test_two_apps_with_one_name_are_refused(self):
        self.assertIn("note", self.refusal(HOOK, HOOK))
