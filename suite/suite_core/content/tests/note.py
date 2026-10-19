"""An editor for an app with no product code: plain text notes, one Text root."""

from pathlib import Path

import pycrdt

from suite.suite_core.content.editors import EditorSpec, HtmlCopy
from suite.suite_core.content.ingest import EditorSchema

SPEC = EditorSpec(
    app="note",
    doctype="Content Layer Note",
    body_field="body",
    part_map={"text": pycrdt.Text},
    schema=EditorSchema(
        1,
        {"text": 1},
        content_refs=frozenset({0, 1, 4}),
        shared_types=frozenset(),
        nodes=frozenset(),
        marks=frozenset(),
    ),
    checker_build=Path(__file__).with_name("note_checker.cjs"),
    readable_copy=HtmlCopy(field="html", is_html_complete=lambda state, html, text: True),
    media=None,
)
