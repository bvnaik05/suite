"""The update log: every committed change to a collaborative document, in one order.

Pushes take the control row with `SKIP LOCKED` as the first statement of a fresh
transaction, so a web thread never waits on a document: a held lock answers
`busy` at once. Only a hiding or closing tab's last push, which can't retry,
waits up to two seconds for it, and only one such push per document at a time.
Each row gets the next gap-free `rev` and extends a hash chain, and is committed
before the push answers. A push that repeats seqs already committed gets their
original answer back, checked against each seq's sha, so a lost answer costs one
request and never a second row. One that also reaches past them commits only the rest.
"""

import contextlib
import hashlib
import json
import secrets
from collections.abc import Iterator

import frappe
import pycrdt
from frappe.utils import now_datetime
from frappe.utils.background_jobs import get_redis_conn
from redis.exceptions import RedisError

from suite.suite_core.content import admission, capacity, ingest, live, stage, updates
from suite.suite_core.content.adapters import spec_of
from suite.suite_core.content.log import Refusal, chain_next
from suite.suite_core.content.sessions import load_session, session_for
from suite.suite_core.content.snapshot import start_clocks
from suite.suite_core.content.tables import table
from suite.suite_core.content.wire import PACE_MS, busy_refusal

# A push stamped by a newer build than this server waits out the deploy
UPGRADING_RETRY_MS = 30_000
SUSPECT_RETRY_MS = 5 * 60_000
FINAL_PUSH_WAIT_S = 2


def replay(adapter: str, doc_id: str, header: dict, acked_seq: int, head_rev: int) -> dict | None:
    """The original answer for a push the session already committed, if every sha matches. A push
    that starts inside the committed seqs and reaches past them is only checked."""
    if header["from"] > acked_seq:
        return None

    last_seq = min(header["to"], acked_seq)
    rows = frappe.db.sql(
        f"""SELECT `rev`, `seq_from`, `seq_to`, `seq_shas`, `chain` FROM `{table(adapter, "update")}`
        WHERE `doc_id` = %s AND `sid` = %s AND `seq_to` >= %s AND `seq_from` <= %s ORDER BY `rev`""",
        (doc_id, header["sid"], header["from"], last_seq),
        as_dict=True,
    )

    stored_seqs = {}
    for row in rows:
        shas = bytes(row.seq_shas)
        for index, seq in enumerate(range(int(row.seq_from), int(row.seq_to) + 1)):
            stored_seqs[seq] = (shas[32 * index : 32 * index + 32], row)

    for seq in range(header["from"], last_seq + 1):
        sha, _row = stored_seqs.get(seq, (None, None))
        if sha != header["shas"][seq - header["from"]]:
            raise Refusal(409, "seq_conflict")

    if header["to"] > acked_seq:
        return None

    # Every seq from `from` through `last_seq` matched a stored row, so `last_seq` has one
    last_row = stored_seqs[last_seq][1]
    return {
        "dup": True,
        "rev": int(last_row.rev),
        "chain": bytes(last_row.chain).hex(),
        "acked": acked_seq,
        "head": head_rev,
        "pace_ms": PACE_MS,
    }


@contextlib.contextmanager
def lock_clause(adapter: str, doc_id: str, final: bool) -> Iterator[str]:
    """How a push takes the control row: a final push waits, one per document, so they can't tie up the workers."""
    if not final:
        yield "SKIP LOCKED"
        return

    key = f"suite:collab:final-wait:{frappe.local.site}:{adapter}:{doc_id}"
    token = secrets.token_hex(16)
    # Without Redis the push still goes, only without waiting
    try:
        redis = get_redis_conn()
        taken = redis.set(key, token, nx=True, ex=FINAL_PUSH_WAIT_S + 1)
    except RedisError:
        taken = False

    if not taken:
        yield "SKIP LOCKED"
        return

    try:
        yield f"WAIT {FINAL_PUSH_WAIT_S}"
    finally:
        # A key left behind expires by itself
        with contextlib.suppress(RedisError):
            redis.eval(admission.RELEASE_SCRIPT, 1, key, token)


def unacked_part(header: dict, payload: bytes, acked: int, next_clock: int) -> tuple[dict, bytes]:
    """The seqs of a push past `acked`, with the update cut to the writer's clocks from `next_clock`."""
    committed = acked + 1 - header["from"]
    state = updates.encoded_uint(1) + updates.encoded_uint(header["cid"]) + updates.encoded_uint(next_clock)
    unacked = {**header, "from": acked + 1, "shas": header["shas"][committed:]}
    return unacked, pycrdt.get_update(payload, state)


def assembled_payload(adapter: str, doc_id: str, header: dict) -> bytes:
    try:
        return stage.assemble(adapter, doc_id, header["stage_id"], header)
    except stage.Conflict:
        raise Refusal(409, "stage_conflict") from None
    except stage.Incomplete:
        raise Refusal(409, "stage_incomplete") from None


def push(adapter: str, doc_id: str, header: dict, payload: bytes, principal: str) -> dict:
    """Commit one session's contiguous seq range as the next rev, or refuse it."""
    spec = spec_of(adapter)
    schema = spec.schema
    session = session_for(adapter, doc_id, header, principal)
    head = frappe.db.sql(f"SELECT `head_rev` FROM `{table(adapter, 'doc')}` WHERE `id` = %s", doc_id)[0][0]
    replayed = replay(adapter, doc_id, header, int(session.acked_seq), int(head))
    if replayed:
        return replayed

    if header["schema"] > schema.version:
        raise Refusal(423, "upgrading", retry_ms=UPGRADING_RETRY_MS)

    if "stage_id" in header:
        payload = assembled_payload(adapter, doc_id, header)

    if len(payload) > capacity.edit_max(spec.max_change):
        raise Refusal(400, "malformed")

    try:
        row = ingest.check_row(payload, header["cid"])
    except ValueError:
        raise Refusal(400, "malformed") from None

    names_allowed = schema.allows(row.update.names, header["schema"])
    if not names_allowed or not schema.could_write(row.update):
        raise Refusal(409, "poison")

    row_bound = capacity.row_bound(row.update, len(payload))
    # The lock must be the first statement of a fresh transaction
    frappe.db.commit()  # nosemgrep: frappe-manual-commit
    with lock_clause(adapter, doc_id, header.get("final") is True) as lock:
        try:
            locked_rows = frappe.db.sql(
                f"""SELECT `lineage`, `head_rev`, `head_chain`, `mode`, `start_clocks`, `schema_steps`, `suspect_held`,
                `state_bytes`, `tail_rows`, `tail_bound`, `next_compaction_at`, `last_compaction_ms`
                FROM `{table(adapter, "doc")}` WHERE `id` = %s FOR UPDATE {lock}""",
                doc_id,
                as_dict=True,
            )
        except frappe.QueryTimeoutError:
            # Frappe also writes an Error Log row per timeout, which one waiter per document keeps rare
            raise busy_refusal() from None

    if not locked_rows:
        raise busy_refusal()

    doc = locked_rows[0]
    try:
        if doc.mode == "purged":
            raise Refusal(404, "not_found")

        if header["lineage"] != doc.lineage:
            raise Refusal(409, "lineage")

        # The rows stay on the device until an admin reviews the document
        if doc.suspect_held:
            raise Refusal(423, "paused", reason="suspect", retry_ms=SUSPECT_RETRY_MS)

        session = session_for(adapter, doc_id, header, principal)
        acked = int(session.acked_seq)
        head = int(doc.head_rev)
        replayed = replay(adapter, doc_id, header, acked, head)
        if replayed:
            frappe.db.rollback()
            return replayed

        if header["from"] <= acked:
            header, payload = unacked_part(header, payload, acked, int(session.next_clock))
            try:
                row = ingest.check_row(payload, header["cid"])
            except ValueError:
                raise Refusal(400, "malformed") from None

            row_bound = capacity.row_bound(row.update, len(payload))

        if header["from"] != acked + 1:
            raise Refusal(409, "seq", acked=acked)

        if header["seen_rev"] > head:
            raise Refusal(409, "diverged")

        try:
            capacity.admit(doc, row.update, row_bound, now_datetime(), spec.max_state)
        except capacity.Full as full:
            raise Refusal(423, full.reason, retry_ms=full.retry_ms) from None

        try:
            ingest.check_closed(adapter, doc_id, row, header["cid"], start_clocks(doc))
        except ingest.Unclosed as unclosed:
            raise Refusal(409, unclosed.reason, **unclosed.extra) from None

        rev = head + 1
        schema_steps = json.loads(doc.schema_steps)
        if header["schema"] > schema_steps[-1][1]:
            schema_steps.append([rev, header["schema"]])

        payload_sha = hashlib.sha256(payload).digest()
        chain = chain_next(bytes(doc.head_chain), rev, payload_sha)
        now = now_datetime()
        frappe.db.sql(
            f"""INSERT INTO `{table(adapter, "update")}`
            (`doc_id`, `rev`, `sid`, `seq_from`, `seq_to`, `client_id`, `schema`, `payload`, `bound`, `sha256`, `seq_shas`, `chain`, `created`)
            VALUES (%s, %s, %s, %s, %s, %s, %s, UNHEX(%s), %s, UNHEX(%s), UNHEX(%s), UNHEX(%s), %s)""",
            (
                doc_id,
                rev,
                header["sid"],
                header["from"],
                header["to"],
                header["cid"],
                header["schema"],
                payload.hex(),
                row_bound,
                payload_sha.hex(),
                b"".join(header["shas"]).hex(),
                chain.hex(),
                now,
            ),
        )
        frappe.db.sql(
            f"""UPDATE `{table(adapter, "doc")}` SET `head_rev` = %s, `head_chain` = UNHEX(%s),
            `tail_rows` = `tail_rows` + 1, `tail_bytes` = `tail_bytes` + %s, `tail_bound` = `tail_bound` + %s,
            `schema_steps` = %s WHERE `id` = %s""",
            (rev, chain.hex(), len(payload), row_bound, json.dumps(schema_steps), doc_id),
        )
        if "stage_id" in header:
            stage.drop_stage(adapter, doc_id, header["stage_id"])

        next_clock = row.clock_to if row.update.structs else session.next_clock
        frappe.db.sql(
            f"""UPDATE `{table(adapter, "session")}` SET `acked_seq` = %s, `next_clock` = %s, `last_push_at` = %s
            WHERE `doc_id` = %s AND `sid` = %s""",
            (
                header["to"],
                next_clock,
                now,
                doc_id,
                header["sid"],
            ),
        )
        frappe.db.commit()  # nosemgrep: frappe-manual-commit
    except BaseException:
        frappe.db.rollback()
        raise

    live.publish_row(adapter, doc_id, doc.lineage, rev, header["schema"], payload)
    return {
        "rev": rev,
        "head": rev,
        "chain": chain.hex(),
        "acked": header["to"],
        "pace_ms": PACE_MS,
    }


def put_piece(
    adapter: str, doc_id: str, stage_id: str, header: dict, index: int, piece: bytes, principal: str
) -> dict:
    """Stage one piece of a big change for this principal's session. A piece of a change the
    session already committed is answered as a duplicate and not kept."""
    doc = frappe.db.sql(
        f"SELECT `lineage`, `mode` FROM `{table(adapter, 'doc')}` WHERE `id` = %s", doc_id, as_dict=True
    )[0]
    if doc.mode == "purged":
        raise Refusal(404, "not_found")

    if header["lineage"] != doc.lineage:
        raise Refusal(409, "lineage")

    session = load_session(adapter, doc_id, header["sid"], principal)
    if session is None:
        raise Refusal(409, "session_unknown")

    if session.closed:
        raise Refusal(409, "client_closed")

    if int(session.acked_seq) >= header["to"]:
        return {"dup": True}

    try:
        stage.store_piece(adapter, doc_id, stage_id, index, header, piece, principal)
    except stage.Conflict:
        raise Refusal(409, "stage_conflict") from None
    except stage.Full:
        raise Refusal(423, "stage_full", retry_ms=stage.FULL_RETRY_MS) from None

    return {"staged": index}
