"""The content layer's routes: /api/suite/content/{node}/..., where the node's Drive type picks the app.

Bodies and answers are binary frames, so these handlers answer with their own
responses instead of the JSON envelope. Every request names the user the
tab expects, and that is checked before Drive is asked, so an expired sign-in
answers `signed_out` rather than a permission verdict. Guests are heard for
the same reason, but only to read: guest editing waits for stage G.
"""

import dataclasses
import io
import json
from typing import IO, cast

import frappe
from frappe import _
from werkzeug.wrappers import Response

from suite import drive
from suite.composition.http import HttpOwner, Route
from suite.suite_core import content
from suite.suite_core.content import editors
from suite.writer import drive as writer_drive

# Every row reads or writes its own bytes, so each is a stream; a POST answers JSON
ROUTES = (
    Route(
        "GET",
        "{node}/document",
        "document_get",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        stream=True,
        kind="query",
        public_name="content.open",
    ),
    Route(
        "GET",
        "{node}/updates",
        "updates_get",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        stream=True,
        kind="query",
        public_name="content.pull",
    ),
    Route(
        "POST",
        "{node}/updates",
        "updates_post",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.push",
    ),
    Route(
        "PUT",
        "{node}/stage/{stage_id}/{piece_index}",
        "stage_put",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.stage",
    ),
    Route(
        "POST",
        "{node}/sessions",
        "sessions_post",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.startSession",
    ),
    Route(
        "POST",
        "{node}/suspect",
        "suspect_post",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.reportSuspect",
    ),
    Route(
        "POST",
        "{node}/html",
        "html_post",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.submitRender",
    ),
    Route(
        "POST",
        "{node}/restore",
        "restore_post",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.beginRestore",
    ),
    Route(
        "POST",
        "{node}/restore/cancel",
        "restore_cancel_post",
        allow_guest=True,
        errors=(drive.DriveNotFound, drive.DriveForbidden, drive.DriveLocked),
        output=dict[str, int | str],
        stream=True,
        kind="mutation",
        public_name="content.cancelRestore",
    ),
)

EXPECTED_USER_HEADER = "X-Expected-User"

HTML_FORMAT = "html"
HTML_MIME = "text/html"
VERSION_MIME = "application/json"

DRIVE_REFUSALS = (
    (drive.DriveNotFound, 404, "not_found"),
    (drive.DriveForbidden, 403, "forbidden"),
    (drive.DriveLinkExpired, 403, "link_expired"),
    (drive.DriveLocked, 401, "locked"),
)


@frappe.whitelist(allow_guest=True, methods=["GET"])
def document_get(node: str):
    def answer() -> bytes:
        app = authorize_node(node, drive.READ, frappe.get_request_header(EXPECTED_USER_HEADER))
        can_write = frappe.session.user != "Guest" and can_access(node, drive.EDIT)
        return content.open_document(app, node, can_write=can_write)

    return respond_or_refuse(answer)


@frappe.whitelist(allow_guest=True, methods=["GET"])
def updates_get(node: str, since_rev: str | None = None, q_epoch: str | None = None):
    return respond_or_refuse(
        lambda: content.pull_rows(authorized(node, drive.READ), node, since_rev, q_epoch)
    )


@frappe.whitelist(allow_guest=True, methods=["POST"])
def updates_post(node: str):
    def authorize(expected_user: object) -> str:
        return authorize_node(node, drive.EDIT, expected_user)

    return respond_or_refuse(lambda: content.push_rows(node, frappe.request.get_data(), authorize))


@frappe.whitelist(allow_guest=True, methods=["PUT"])
def stage_put(node: str, stage_id: str, piece_index: str):
    return respond_or_refuse(
        lambda: content.stage_piece(
            authorized(node, drive.EDIT), node, stage_id, piece_index, frappe.request.get_data()
        )
    )


@frappe.whitelist(allow_guest=True, methods=["POST"])
def sessions_post(node: str):
    return respond_or_refuse(lambda: content.start_session(authorized(node, drive.EDIT), node, json_body()))


@frappe.whitelist(allow_guest=True, methods=["POST"])
def suspect_post(node: str):
    return respond_or_refuse(lambda: content.report_suspect(authorized(node, drive.READ), node, json_body()))


@frappe.whitelist(allow_guest=True, methods=["POST"])
def html_post(node: str):
    return respond_or_refuse(lambda: content.submit_render(authorized(node, drive.EDIT), node, json_body()))


@frappe.whitelist(allow_guest=True, methods=["POST"])
def restore_post(node: str):
    return respond_or_refuse(lambda: content.begin_restore(authorized(node, drive.EDIT), node, json_body()))


@frappe.whitelist(allow_guest=True, methods=["POST"])
def restore_cancel_post(node: str):
    return respond_or_refuse(lambda: content.cancel_restore(authorized(node, drive.EDIT), node, json_body()))


@frappe.whitelist(allow_guest=True, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
def unknown() -> None:
    raise frappe.DoesNotExistError(_("That content address does not exist"))


def authorized(node: str, role: int) -> str:
    """The node's app, once the tab's sign-in and its access to the node are checked."""
    return authorize_node(node, role, frappe.get_request_header(EXPECTED_USER_HEADER))


def json_body() -> dict:
    """The request's JSON object; empty when the body is missing, unreadable or not an object."""
    try:
        body = json.loads(frappe.request.get_data() or b"{}")
    except ValueError:
        return {}

    if not isinstance(body, dict):
        return {}

    return body


def authorize_node(node: str, role: int, expected_user) -> str:
    """Who the tab says it is, then the app that keeps the node, then what Drive says it may do.
    Editing needs a signed-in user. Answers the app's name."""
    require_expected_user(expected_user)
    if role == drive.EDIT and frappe.session.user == "Guest":
        raise content.Refusal(401, "signed_out")

    app = app_of(node)
    check_drive_access(node, role)
    return app


def app_of(node: str) -> str:
    """A node of a type no app keeps here is not found, as a missing one is."""
    content_type = frappe.db.get_value("Drive Node", node, "content_doctype")
    spec = editors.for_type(content_type) if content_type else None
    if spec is None:
        raise content.Refusal(404, "not_found")

    return spec.app


def check_drive_access(node: str, role: int) -> None:
    try:
        drive.check(node, role)
    except drive.DriveError as error:
        for kind, status, reason in DRIVE_REFUSALS:
            if isinstance(error, kind):
                raise content.Refusal(status, reason) from None
        raise


def can_access(node: str, role: int) -> bool:
    try:
        check_drive_access(node, role)
    except (content.Refusal, drive.DriveError):
        return False
    return True


def require_expected_user(expected_user) -> None:
    if expected_user == frappe.session.user:
        return

    if frappe.session.user == "Guest":
        raise content.Refusal(401, "signed_out")

    raise content.Refusal(409, "user_changed")


def respond_or_refuse(answer) -> Response:
    """`answer`'s frame, or its status and JSON body, as the response; a refusal as its own."""
    try:
        reply = answer()
    except content.Refusal as refusal:
        return json_response(refusal.status, refusal.body)

    if isinstance(reply, bytes):
        return Response(reply, status=200, mimetype="application/octet-stream")

    status, body = reply
    return json_response(status, body)


def json_response(status: int, body: dict) -> Response:
    text = json.dumps(body)
    return Response(text, status=status, mimetype="application/json")


def node_owner(node: str) -> str | None:
    return frappe.db.get_value("Drive Node", node, "owner")


def touch_body(node: str) -> None:
    doctype = frappe.db.get_value("Drive Node", node, "content_doctype")
    document_name = frappe.db.get_value(doctype, {drive.node_field(doctype): node})
    drive.touch(doctype, document_name)


def version_body(node: str, kind: str, label: str | None) -> None:
    """Store the document's body as a Drive version of `kind`; a milestone Drive refuses is refused."""
    try:
        drive.take_version(node, kind=kind, label=label)
    except drive.DriveError as error:
        if kind != "milestone":
            raise

        raise content.Refusal(409, "milestone_failed", message=str(error)) from None


NODES = content.NodeHooks(
    owner=node_owner, touch=touch_body, take_version=version_body, node_field=drive.node_field
)


def with_content(spec: drive.ContentTypeSpec) -> drive.ContentTypeSpec:
    """`spec` with the content layer's branch for a document in a log around each row-only callback."""
    base_export = declared(spec.export, "export")
    base_version_bytes = declared(spec.version_bytes, "version_bytes")
    base_restore_version = declared(spec.restore_version, "restore_version")
    base_on_purge = declared(spec.on_purge, "on_purge")
    base_used_nodes = declared(spec.used_nodes, "used_nodes")
    base_remap_media = declared(spec.remap_media, "remap_media")

    def app() -> str:
        found = editors.for_type(spec.doctype)
        if found is None:
            raise frappe.DoesNotExistError(f"No editor for the content type {spec.doctype}")

        return found.app

    def node_of(docname: str) -> str | None:
        return frappe.db.get_value(spec.doctype, docname, spec.node_field)

    def create_empty(node: str) -> str:
        docname = spec.create_empty(node)
        content.start(app(), node)
        return docname

    def duplicate(source_docname: str, node: str) -> str:
        docname = spec.duplicate(source_docname, node)
        source_node = node_of(source_docname)
        try:
            if source_node:
                content.copy(app(), source_node, node)
        except content.NotReady as unready:
            raise drive.DriveConflict(_("This document cannot be copied right now")) from unready
        return docname

    def export(docname: str, format: str) -> tuple[IO[bytes], str]:
        node = node_of(docname)
        if format != HTML_FORMAT or not node:
            return base_export(docname, format)

        try:
            html = content.html(app(), node)
        except content.NotReady as stale:
            raise drive.DriveConflict(_("Open the document to refresh its export")) from stale
        if html is None:
            return base_export(docname, format)

        return io.BytesIO(html.encode("utf-8")), HTML_MIME

    def version_bytes(docname: str) -> tuple[IO[bytes], str]:
        node = node_of(docname)
        try:
            if node:
                record = content.version(app(), node)
            else:
                record = None
        except content.NotReady as unready:
            raise drive.DriveConflict(
                _("Version history is not available for this document right now")
            ) from unready
        if record is None:
            return base_version_bytes(docname)

        return io.BytesIO(record), VERSION_MIME

    def restore_version(docname: str, stream) -> None:
        node = node_of(docname)
        if node and content.find(app(), node):
            raise drive.DriveConflict(_("Open the document to restore this version"))

        prefix = content.record_prefix(app())
        head = read_head(stream, len(prefix))
        if head == prefix:
            raise drive.DriveConflict(_("This version can be restored only while collaboration is on"))

        base_restore_version(docname, cast(IO[bytes], ReplayedStream(head, stream)))

    def on_purge(docname: str) -> None:
        node = node_of(docname)
        if node:
            content.purge(app(), node)

        base_on_purge(docname)

    def used_nodes(docname: str) -> set[str]:
        row_ids = base_used_nodes(docname)
        node = node_of(docname)
        if not node:
            return row_ids

        return row_ids | content.media_ids(app(), node)

    def remap_media(docname: str, mapping: dict[str, str]) -> None:
        if not mapping:
            return

        node = node_of(docname)
        try:
            if node:
                remapped = content.remap(app(), node, mapping)
            else:
                remapped = False
        except content.NotReady as refused:
            raise drive.DriveConflict(_("The copy's pictures could not be moved to it")) from refused
        if not remapped:
            base_remap_media(docname, mapping)

    def threads_changed(node: str) -> None:
        content.threads_changed(app(), node)

    return dataclasses.replace(
        spec,
        create_empty=create_empty,
        duplicate=duplicate,
        export=export,
        version_bytes=version_bytes,
        restore_version=restore_version,
        on_purge=on_purge,
        used_nodes=used_nodes,
        remap_media=remap_media,
        threads_changed=threads_changed,
    )


def declared[T](callback: T | None, name: str) -> T:
    """Return `callback`, which a spec wrapped for the content layer must declare."""
    if callback is None:
        raise ValueError(f"A spec wrapped for the content layer must declare {name}")

    return callback


def read_head(stream: IO[bytes], size: int) -> bytes:
    """Up to the first `size` bytes of `stream`, fewer only at its end."""
    head = b""
    for _attempt in range(size):
        part = stream.read(size - len(head))
        head += part
        if not part or len(head) == size:
            break

    return head


class ReplayedStream:
    """`stream` read again from its start: the `head` already read from it, then the rest."""

    def __init__(self, head: bytes, stream: IO[bytes]) -> None:
        self.head = head
        self.stream = stream

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            data = self.head + self.stream.read()
            self.head = b""
            return data

        data = self.head[:size]
        self.head = self.head[size:]
        if len(data) < size:
            data += self.stream.read(size - len(data))

        return data


WRITER = with_content(writer_drive.SPEC)

HTTP = HttpOwner(
    owner="content",
    prefix="/api/suite/content/",
    target="suite.composition.content",
    routes=ROUTES,
    strip_owner=False,
)
