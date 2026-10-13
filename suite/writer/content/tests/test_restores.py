import json
import uuid
from datetime import timedelta
from http import HTTPStatus
from unittest.mock import patch

import frappe
import pycrdt
from frappe.utils import now_datetime

from suite import drive
from suite.composition import content as routes
from suite.writer.content.tests.support import CheckpointCase, answer, call_route, push_body, read_open


class TestRestoreFence(CheckpointCase):
    """A restore holds the document still, after a version of what it held."""

    def setUp(self):
        super().setUp()
        self.node = self.new_document()
        self.type_into(self.node, ["one", " two"])

    def begin(self, version: int = 1, seen_rev: int | None = None):
        head = int(self.doc_row(self.node).head_rev)
        body = json.dumps({"seen_rev": head if seen_rev is None else seen_rev, "version": version})
        response = call_route(routes.restore_post, self.node, body=body.encode())
        return response.status_code, answer(response)

    def cancel(self, token: str):
        body = json.dumps({"token": token}).encode()
        return call_route(routes.restore_cancel_post, self.node, body=body).status_code

    def milestones(self) -> list[str]:
        rows = drive.list_versions(self.node)["rows"]
        return [row["label"] for row in rows if row["kind"] == "milestone"]

    def test_a_restore_begins_at_the_head_and_holds_every_other_push(self):
        status, fence = self.begin()

        self.assertEqual(
            (status, fence["base_rev"], len(fence["token"]), fence["fence_ms"]), (200, 2, 32, 120_000)
        )
        self.assertEqual(self.refused_push(), (423, {"collab": "paused", "reason": "restoring"}))

    def test_a_version_of_the_head_is_taken_first_and_once_while_nothing_changes(self):
        _status, fence = self.begin(version=3)
        self.cancel(fence["token"])
        self.begin(version=3)

        self.assertEqual(self.milestones(), ["Before restoring version 3"])

    def test_an_edit_since_the_last_one_takes_a_new_version(self):
        _status, fence = self.begin(version=3)
        self.cancel(fence["token"])
        self.type_into(self.node, [" three"])
        self.begin(version=4)

        self.assertEqual(self.milestones(), ["Before restoring version 4", "Before restoring version 3"])

    def test_a_tab_missing_rows_is_sent_to_pull_first(self):
        self.assertEqual(self.begin(seen_rev=1), (409, {"collab": "behind", "head": 2}))
        self.assertEqual(self.refused_push(), None)

    def test_a_second_restore_waits_for_the_first(self):
        self.begin()

        self.assertEqual(self.begin(), (409, {"collab": "restoring"}))

    def test_a_cancelled_restore_lets_edits_in_again(self):
        _status, fence = self.begin()

        self.assertEqual(self.cancel(fence["token"]), 200)
        self.assertEqual(self.refused_push(), None)
        self.assertEqual(self.doc_row(self.node).mode, "active")

    def test_a_restore_nobody_finishes_lapses_at_its_deadline(self):
        self.begin()
        self.set_doc(self.node, restore_deadline=now_datetime() - timedelta(seconds=1))

        pushed = self.refused_push()
        status, _fence = self.begin()

        self.assertEqual((pushed, status), (None, 200))

    def test_a_restore_within_a_minute_of_the_last_says_how_long_to_wait(self):
        self.set_doc(self.node, restored_at=now_datetime() - timedelta(seconds=15))
        status, refusal = self.begin()

        self.assertEqual((status, refusal["collab"]), (409, "restore_recent"))
        self.assertIn(refusal["retry_s"], (44, 45, 46))
        self.set_doc(self.node, restored_at=now_datetime() - timedelta(seconds=61))
        status, _fence = self.begin()
        self.assertEqual(status, 200)

    def test_no_restore_begins_when_the_version_before_it_cant_be_taken(self):
        refused = drive.DriveOverQuota("The drive is full")
        with patch.object(drive, "take_version", side_effect=refused):
            status, refusal = self.begin()

        self.assertEqual((status, refusal["collab"]), (409, "milestone_failed"))
        self.assertEqual((self.doc_row(self.node).mode, self.milestones()), ("active", []))
        self.assertEqual(self.refused_push(), None)

    # How the server answers another tab's push of one word; None when it goes in
    def refused_push(self) -> tuple[int, dict] | None:
        sid = uuid.uuid4().hex
        session = call_route(routes.sessions_post, self.node, body=json.dumps({"sid": sid}).encode())
        header, checkpoint, rows = read_open(call_route(routes.document_get, self.node).get_data())
        doc = pycrdt.Doc(client_id=answer(session)["client_id"])
        for payload in [checkpoint, *(payload for _rev, payload in rows)]:
            if payload:
                doc.apply_update(payload)

        seen = doc.get_state()
        doc.get("default", type=pycrdt.XmlFragment).children[0].insert(0, "late")
        seen_rev = 0
        if rows:
            seen_rev = rows[-1][0]

        body = push_body(header["lineage"], sid, doc.client_id, 1, seen_rev, doc.get_update(seen))
        response = call_route(routes.updates_post, self.node, body=body)
        if response.status_code == HTTPStatus.OK:
            return None

        refusal = answer(response)
        refusal.pop("retry_ms", None)
        return response.status_code, refusal
