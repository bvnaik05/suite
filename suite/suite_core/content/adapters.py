"""The apps whose documents the content layer keeps, found through the `suite_content_adapters` hook."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import frappe

from suite.suite_core.content.ingest import EditorSchema


@dataclass(frozen=True)
class ContentAdapterSpec:
    """One app's plug-in. `name` is also its table prefix; `content_type` is its Drive content type and
    the doctype whose row holds each document's latest checked body, base64, in `body_field`, found by
    its node in `node_field`; `roots` names every root type it writes; `kernel` is the Node bundle that
    judges suspect documents. `codec` names the update format of its state, `max_state` the most a compacted
    document may hold and `max_change` the most one change may, in bytes. `check_copy(state, html, text)` says
    whether a readable copy a browser rendered holds what the state does. `file_values(state)` names the Drive
    nodes a state uses, and `rewrite_files(mapping)` is how a stored value names a copy's nodes instead."""

    name: str
    content_type: str
    body_field: str
    node_field: str
    roots: Mapping[str, type]
    schema: EditorSchema
    kernel: Path
    codec: str
    max_state: int
    max_change: int
    check_copy: Callable[[bytes, str, str], bool]
    # The state an old body holds. It decides none of the conversion rules (when, whether for good, what is
    # kept), which wait for the second grill and ticket 29
    convert: Callable[[str], bytes]
    file_values: Callable[[bytes], set[str]]
    rewrite_files: Callable[[Mapping[str, str]], Callable[[str], str]]


@dataclass(frozen=True)
class NodeHooks:
    """What the layer asks about a document's node, the same for every app, given through the
    `suite_content_nodes` hook: `owner` names the node's owner, and `touch` records that the body
    of an app's document changed."""

    owner: Callable[[str], str | None]
    touch: Callable[[ContentAdapterSpec, str], None]


def adapters() -> dict[str, ContentAdapterSpec]:
    found: dict[str, ContentAdapterSpec] = {}
    for path in frappe.get_hooks("suite_content_adapters") or ():
        spec = frappe.get_attr(path)
        if not isinstance(spec, ContentAdapterSpec) or spec.name in found:
            raise ValueError(f"Invalid content adapter {path}")

        found[spec.name] = spec

    return found


def spec_of(name: str) -> ContentAdapterSpec:
    found = adapters().get(name)
    if found is None:
        raise frappe.DoesNotExistError(f"Unknown content adapter {name}")

    return found


def for_type(content_type: str) -> ContentAdapterSpec | None:
    """The adapter for a Drive content type, or None when no app keeps that type's documents here."""
    return next((spec for spec in adapters().values() if spec.content_type == content_type), None)


def node_hooks() -> NodeHooks:
    paths = list(frappe.get_hooks("suite_content_nodes") or ())
    if len(paths) != 1:
        raise ValueError(f"Expected one suite_content_nodes hook, found {len(paths)}")

    hooks = frappe.get_attr(paths[0])
    if not isinstance(hooks, NodeHooks):
        raise ValueError(f"Invalid content node hooks {paths[0]}")

    return hooks
