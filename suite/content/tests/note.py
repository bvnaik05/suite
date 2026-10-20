"""An editor for an app with no product code: plain text notes, one Text root."""

from pathlib import Path

import pycrdt

from suite import drive
from suite.content import with_content
from suite.content.editors import EditorSpec, HtmlCopy
from suite.content.ingest import EditorSchema

EDITOR = EditorSpec(
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


def never_called(*args):
    raise NotImplementedError("The note tests call no Drive callback")


SPEC = with_content(
    drive.ContentTypeSpec(
        doctype="Content Layer Note",
        mime="text/plain",
        node_field="node",
        create_empty=never_called,
        duplicate=never_called,
        export=never_called,
        version_bytes=never_called,
        restore_version=never_called,
        on_purge=never_called,
        used_nodes=never_called,
        remap_media=never_called,
    )
)
