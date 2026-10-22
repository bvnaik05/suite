import base64
import json
from collections.abc import Iterator
from typing import NotRequired, TypedDict

import frappe
import mimemapper

from suite import drive
from suite.content import convert
from suite.writer import content as writer_content
from suite.writer.drive import VERSION_SCHEMA, _read_bounded, _version_payload

# To be moved to mimemapper
QUICK_MAP = {
    "video/quicktime": "mov",
    "image/gif": "gif",
}


class VersionConversion(TypedDict):
    state: NotRequired[str]
    reason: NotRequired[str]


class OldBody(TypedDict):
    content: NotRequired[str]


@frappe.whitelist(allow_guest=True, methods=["GET"])
def old_body(node: str) -> OldBody:
    """Answer the Yjs body of the latest `writer-document/1` version, the one conversion kept."""
    drive.check(node, drive.READ)
    payloads = (version_object(node, seq) for seq in version_seqs(node))
    payload = next((found for found in payloads if found.get("schema") == VERSION_SCHEMA), {})
    body: OldBody = {}
    if payload.get("content"):
        body["content"] = payload["content"]

    return body


def version_seqs(node: str) -> Iterator[int]:
    """Yield the node's version numbers, newest first, a page at a time."""
    cursor = None
    while True:
        page = drive.list_versions(node, cursor=cursor)
        yield from (row["seq"] for row in page["rows"])
        cursor = page["next_cursor"]
        if not cursor:
            return


def version_object(node: str, seq: int) -> dict:
    """Read version `seq` as its JSON object; an HTML version reads as an empty one."""
    try:
        payload = json.loads(_read_bounded(drive.read_version(node, seq)))
    except ValueError:
        return {}

    if not isinstance(payload, dict):
        return {}

    return payload


@frappe.whitelist(allow_guest=True, methods=["POST"])
def convert_version(node: str, seq: int) -> VersionConversion:
    """Convert an old `writer-document/1` version for a restore; EDIT only, as each call starts a Node child."""
    drive.check(node, drive.EDIT)
    legacy = _version_payload(_read_bounded(drive.read_version(node, int(seq))))
    try:
        converted = convert.convert(
            writer_content.CONVERTER_BUILD,
            writer_content.CONVERTER_VERSION,
            {**legacy, "ycomments": None},
        )
    except convert.ConverterChanged:
        converted = convert.Refused("converter_changed")

    if isinstance(converted, convert.Converted):
        return {"state": base64.b64encode(converted.state).decode()}

    refusal: VersionConversion = {}
    if "System Manager" in frappe.get_roles():
        refusal["reason"] = "unavailable"
        if converted is not None:
            refusal["reason"] = converted.reason

    return refusal


@frappe.whitelist()
def get_extension(entity_name: str):
    """The file extension of one readable media node, for an export's file names."""
    drive.check(entity_name, drive.READ)
    mime_type = frappe.db.get_value("Drive Node", entity_name, "mime")
    try:
        return mimemapper.get_extension(mime_type)
    except Exception:
        return QUICK_MAP.get(mime_type, "")


@frappe.whitelist()
def create_blog(entity_name: str, html: str, attachments: str | None = None):
    """Publish one readable document's rendered body as a Blog Post, if the blog app is installed."""
    drive.check(entity_name, drive.READ)
    blogger = frappe.db.exists("Blogger", {"user": frappe.session.user})
    if not blogger:
        frappe.throw("Please create a Blogger for your user first.")

    if not frappe.db.exists("Blog Category", {"name": "writer-export"}):
        category = frappe.get_doc({"doctype": "Blog Category", "title": "Writer Export"})
        category.insert()
    else:
        category = frappe.get_doc("Blog Category", "writer-export")

    blog = frappe.get_doc(
        {
            "doctype": "Blog Post",
            "title": frappe.db.get_value("Drive Node", entity_name, "title"),
            "content_type": "HTML",
            "blog_category": category.name,
            "blogger": blogger,
            "content_html": html,
        }
    )
    blog.insert()
    return blog.name
