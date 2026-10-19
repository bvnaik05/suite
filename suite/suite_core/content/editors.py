"""The apps whose documents the content layer keeps, found through the `suite_content_editors` hook."""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import frappe

from suite.suite_core.content.ingest import EditorSchema


@dataclass(frozen=True)
class HtmlCopy:
    """The readable HTML copy of each document, kept in the app's row in `field`. `is_html_complete(state,
    html, text)` says whether a copy a browser rendered holds what the state does."""

    field: str
    is_html_complete: Callable[[bytes, str, str], bool]


@dataclass(frozen=True)
class MediaReferences:
    """The Drive files a document uses: `node_ids(state)` names their nodes, and `value_rewriter(mapping)` is
    how a stored value names a copy's nodes instead."""

    node_ids: Callable[[bytes], set[str]]
    value_rewriter: Callable[[Mapping[str, str]], Callable[[str], str]]


@dataclass(frozen=True)
class EditorSpec:
    """One app's plug-in. `app` is also its table prefix; `doctype` is its Drive content type and the
    doctype whose row holds each document's latest checked body, base64, in `body_field`; `part_map` names
    every root type it writes; `checker_build` is the Node bundle that judges suspect documents and checks
    what trimming deletes. `readable_copy` and `media` are None for an app whose documents keep no HTML
    copy or use no Drive files."""

    app: str
    doctype: str
    body_field: str
    part_map: Mapping[str, type]
    schema: EditorSchema
    checker_build: Path
    readable_copy: HtmlCopy | None
    media: MediaReferences | None


@dataclass(frozen=True)
class NodeHooks:
    """What the layer asks about a document's node, the same for every app, given through the
    `suite_content_nodes` hook: `owner` names the node's owner, `touch` records that its body changed,
    `take_version(node, kind, label)` stores the body as a version of that kind, and `node_field(doctype)`
    names the field of an app's row that holds its node."""

    owner: Callable[[str], str | None]
    touch: Callable[[str], None]
    take_version: Callable[[str, str, str | None], None]
    node_field: Callable[[str], str]


# Short enough that every table name the layer makes from it fits MariaDB's 64 characters
NAME = re.compile(r"[a-z][a-z0-9_]{0,39}")
# The specs this process has checked, by hook path
checked: dict[str, EditorSpec] = {}


def editors() -> dict[str, EditorSpec]:
    found: dict[str, EditorSpec] = {}
    for path in frappe.get_hooks("suite_content_editors") or ():
        spec = load(path)
        if spec.app in found:
            raise ValueError(f"Two editors are for the app {spec.app}")

        found[spec.app] = spec

    return found


def load(path: str) -> EditorSpec:
    try:
        spec = frappe.get_attr(path)
    except TypeError as missing:
        raise ValueError(f"The editor {path} is missing a declaration: {missing}") from missing

    if not isinstance(spec, EditorSpec):
        raise ValueError(f"{path} is not an editor")

    if checked.get(path) is spec:
        return spec

    wrong = wrong_declarations(spec)
    if wrong:
        raise ValueError(f"The editor {path} ({spec.app}) declares {', '.join(wrong)} wrongly")

    checked[path] = spec
    return spec


def wrong_declarations(spec: EditorSpec) -> list[str]:
    def text(value: object) -> bool:
        return isinstance(value, str) and bool(value)

    def copy_right(copy: object) -> bool:
        return copy is None or (
            isinstance(copy, HtmlCopy) and text(copy.field) and callable(copy.is_html_complete)
        )

    def media_right(media: object) -> bool:
        return media is None or (
            isinstance(media, MediaReferences) and callable(media.node_ids) and callable(media.value_rewriter)
        )

    right = {
        "app": isinstance(spec.app, str) and NAME.fullmatch(spec.app) is not None,
        "doctype": text(spec.doctype),
        "body_field": text(spec.body_field),
        "part_map": isinstance(spec.part_map, Mapping)
        and bool(spec.part_map)
        and all(text(root) and isinstance(kind, type) for root, kind in spec.part_map.items()),
        "schema": isinstance(spec.schema, EditorSchema),
        "checker_build": isinstance(spec.checker_build, Path),
        "readable_copy": copy_right(spec.readable_copy),
        "media": media_right(spec.media),
    }
    return [field for field, ok in right.items() if not ok]


def spec_of(app: str) -> EditorSpec:
    found = editors().get(app)
    if found is None:
        raise frappe.DoesNotExistError(f"No editor for the app {app}")

    return found


def for_type(content_type: str) -> EditorSpec | None:
    """The app for a Drive content type, or None when no app keeps that type's documents here."""
    return next((spec for spec in editors().values() if spec.doctype == content_type), None)


def node_hooks() -> NodeHooks:
    paths = list(frappe.get_hooks("suite_content_nodes") or ())
    if len(paths) != 1:
        raise ValueError(f"Expected one suite_content_nodes hook, found {len(paths)}")

    hooks = frappe.get_attr(paths[0])
    if not isinstance(hooks, NodeHooks):
        raise ValueError(f"Invalid content node hooks {paths[0]}")

    return hooks
