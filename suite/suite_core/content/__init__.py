"""Product-neutral content layer.

Each app's collaborative documents are append-only logs of Yjs updates in
tables named for the app. This package holds that plumbing; an app plugs in
with a `EditorSpec` through the `suite_content_editors` hook, and
`suite.composition.content` serves the routes and checks access through Drive,
because `suite_core` never imports Drive or a product. The scheduler and the
queue run `suite.suite_core.content.jobs`.
"""

from suite.suite_core.content.copies import readable_copy
from suite.suite_core.content.copies import wanted as copy_wanted
from suite.suite_core.content.editors import EditorSpec, HtmlCopy, MediaReferences, NodeHooks
from suite.suite_core.content.ingest import EditorSchema
from suite.suite_core.content.live import rooms
from suite.suite_core.content.log import (
    ChainBroken,
    Refusal,
    enabled,
    find,
    require_enabled,
)
from suite.suite_core.content.logged import (
    NotReady,
    copy,
    ensure_tables,
    html,
    media_ids,
    purge,
    record_prefix,
    remap,
    start,
    threads_changed,
    version,
)
from suite.suite_core.content.pushes import push, put_piece
from suite.suite_core.content.restores import header_fields as restore_fields
from suite.suite_core.content.sessions import claim_session, issue_session
from suite.suite_core.content.snapshot import Snapshot, read, rows_after, with_tombstones
from suite.suite_core.content.steps import (
    begin_restore,
    cancel_restore,
    open_document,
    pull_rows,
    push_rows,
    report_suspect,
    stage_piece,
    start_session,
    submit_render,
)
from suite.suite_core.content.wire import (
    PROTOCOL_VERSION,
    encode_frame,
    limits,
    open_header,
    parse_piece,
    parse_push,
)

__all__ = [
    "PROTOCOL_VERSION",
    "ChainBroken",
    "EditorSchema",
    "EditorSpec",
    "HtmlCopy",
    "MediaReferences",
    "NodeHooks",
    "NotReady",
    "Refusal",
    "begin_restore",
    "cancel_restore",
    "claim_session",
    "copy",
    "copy_wanted",
    "enabled",
    "encode_frame",
    "ensure_tables",
    "find",
    "html",
    "issue_session",
    "limits",
    "media_ids",
    "open_document",
    "open_header",
    "parse_piece",
    "parse_push",
    "pull_rows",
    "purge",
    "push",
    "push_rows",
    "put_piece",
    "read",
    "readable_copy",
    "record_prefix",
    "remap",
    "report_suspect",
    "require_enabled",
    "restore_fields",
    "rooms",
    "rows_after",
    "stage_piece",
    "start",
    "start_session",
    "submit_render",
    "threads_changed",
    "version",
    "with_tombstones",
]
