import base64
import json
from collections.abc import Iterator
from typing import NotRequired, TypedDict

import frappe
import mimemapper

from suite import drive
from suite.content import convert, scheduling
from suite.writer import content as writer_content
from suite.writer.drive import VERSION_SCHEMA, _read_bounded, _version_payload

# To be moved to mimemapper
QUICK_MAP = {
    "video/quicktime": "mov",
    "image/gif": "gif",
}

CONVERT_TIMEOUT = 300
# How long a version waits for its job, and its answer for the page to ask again
CONVERSION_KEPT = 600


class VersionConversion(TypedDict):
    state: NotRequired[str]
    reason: NotRequired[str]
    pending: NotRequired[bool]


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
    """Read version `seq` as its JSON object; an HTML version, or one too large to read, reads as an empty one."""
    try:
        payload = json.loads(_read_bounded(drive.read_version(node, seq)))
    except (ValueError, frappe.ValidationError):
        return {}

    if not isinstance(payload, dict):
        return {}

    return payload


@frappe.whitelist(allow_guest=True, methods=["POST"])
def convert_version(node: str, seq: int) -> VersionConversion:
    """Convert an old `writer-document/1` version for a restore in a job, read here as the caller; EDIT only."""
    drive.check(node, drive.EDIT)
    seq = int(seq)
    answer = frappe.cache.get_value(version_key("answer", node, seq))
    if answer is None:
        if frappe.cache.get_value(version_key("input", node, seq)) is None:
            legacy = _version_payload(_read_bounded(drive.read_version(node, seq)))
            frappe.cache.set_value(version_key("input", node, seq), legacy, expires_in_sec=CONVERSION_KEPT)

        scheduling.enqueue(
            "suite.writer.api.docs.run_version_conversion",
            f"suite-writer-convert-version-{node}-{seq}",
            timeout=CONVERT_TIMEOUT,
            node=node,
            seq=seq,
        )
        return {"pending": True}

    if "state" in answer:
        return {"state": answer["state"]}

    refusal: VersionConversion = {}
    if "System Manager" in frappe.get_roles():
        refusal["reason"] = answer["reason"]

    return refusal


def run_version_conversion(node: str, seq: int) -> None:
    """Convert the version `convert_version` read, and keep the answer for its next ask."""
    try:
        if not keep_conversion(node, seq):
            return
    except Exception as error:
        crashed = type(error).__name__
    else:
        frappe.cache.delete_value(version_key("input", node, seq))
        return

    # Outside the except, so no frame or chained error left to log holds the document's text
    frappe.log_error(title="Writer: version conversion crashed", message=f"{node} v{seq}: {crashed}")
    frappe.cache.set_value(
        version_key("answer", node, seq), {"reason": "crashed"}, expires_in_sec=CONVERSION_KEPT
    )
    frappe.cache.delete_value(version_key("input", node, seq))


def keep_conversion(node: str, seq: int) -> bool:
    """Convert the cached version and cache its answer; False once its input has expired."""
    legacy = frappe.cache.get_value(version_key("input", node, seq))
    if legacy is None:
        return False

    try:
        converted = convert.convert(
            writer_content.CONVERTER_BUILD,
            writer_content.CONVERTER_VERSION,
            {**legacy, "ycomments": None},
        )
    except convert.ConverterChanged:
        converted = convert.Refused("converter_changed")

    answer = {"reason": "unavailable"}
    if isinstance(converted, convert.Converted):
        answer = {"state": base64.b64encode(converted.state).decode()}
    elif converted is not None:
        answer = {"reason": converted.reason}

    frappe.cache.set_value(version_key("answer", node, seq), answer, expires_in_sec=CONVERSION_KEPT)
    return True


def version_key(kind: str, node: str, seq: int) -> str:
    """Name the cache key for version `seq`'s conversion input or answer under this converter."""
    return f"suite-writer-version-{kind}-{node}-{seq}-{writer_content.CONVERTER_VERSION}"


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
