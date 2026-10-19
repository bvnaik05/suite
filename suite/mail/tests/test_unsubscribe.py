# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt
"""Unsubscribing from a list: which mail offers it, which way the request goes, and what is left
marked. The mail server and the sender's server are stood in for; the rules are the module's."""

from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import frappe
from frappe.tests import UnitTestCase

from suite.mail import unsubscribe
from suite.suite_core.public_http import PublicResponse

ONE_CLICK = "https://news.example.com/u/123"
MAILTO = "mailto:leave@news.example.com?subject=remove%20me"


def message(id: str = "m", *, urls=(ONE_CLICK, MAILTO), post="List-Unsubscribe=One-Click", **fields) -> dict:
    return {
        "id": id,
        "header:List-Unsubscribe:asURLs": list(urls) if urls is not None else None,
        "header:List-Unsubscribe-Post:asText": post,
        "keywords": {},
        "mailboxIds": {"inbox": True},
        "to": [{"email": "Me@Example.com"}],
        "cc": [],
        **fields,
    }


class Stubs:
    """The mail server holding `emails`, and a sender's server answering `status`."""

    def __init__(self, emails: list[dict], status: int = 200, error: Exception | None = None):
        self.emails = emails
        self.posts: list[tuple] = []
        self.queued: list[dict] = []
        self.marked: list[dict] = []
        self.status, self.error = status, error

    def __enter__(self):
        client = MagicMock()
        client.batch.return_value.__enter__.return_value.mail.email.set.side_effect = (
            lambda update: self.marked.append(update)
        )

        def post(method, url, **kwargs):
            self.posts.append((method, url, kwargs))
            if self.error:
                raise self.error
            return PublicResponse(url, self.status, {}, b"")

        wire = [MagicMock(to_wire=MagicMock(return_value=email)) for email in self.emails]
        self.stack = ExitStack()
        for target, value in [
            ("_check_owner", MagicMock()),
            ("get_account_client", MagicMock(return_value=client)),
            ("chunked_get", MagicMock(return_value=wire)),
            ("get_mailbox_id_by_role", MagicMock(return_value="junk")),
            ("get_account_emails", MagicMock(return_value=["me@example.com", "other@example.com"])),
            ("get_user_for_jmap_account", MagicMock(return_value="me@example.com")),
            ("request_public", post),
            ("log_mail_error", MagicMock()),
        ]:
            self.stack.enter_context(patch.object(unsubscribe, target, value))
        self.stack.enter_context(
            patch(
                "suite.mail.doctype.mail_queue.mail_queue.MailQueue._create",
                side_effect=lambda **kwargs: self.queued.append(kwargs),
            )
        )
        self.stack.enter_context(
            patch("suite.mail.doctype.mail_message.mail_message._remove_cached_messages")
        )
        return self

    def __exit__(self, *exc):
        self.stack.close()


class TestWhichMailOffersIt(UnitTestCase):
    def test_reads_the_ways_the_header_offers(self):
        with Stubs([message()]):
            self.assertEqual(
                unsubscribe.options("account", ["m"]),
                {
                    "m": {
                        "one_click": ONE_CLICK,
                        "mailto": MAILTO,
                        "link": ONE_CLICK,
                        "unsubscribed": False,
                    }
                },
            )

    def test_mail_without_the_header_offers_nothing(self):
        with Stubs([message(urls=None)]):
            self.assertEqual(unsubscribe.options("account", ["m"]), {})

    def test_mail_in_junk_offers_nothing(self):
        with Stubs([message("a", mailboxIds={"junk": True}), message("b", keywords={"$junk": True})]):
            self.assertEqual(unsubscribe.options("account", ["a", "b"]), {})

    def test_one_click_only_where_the_sender_allows_the_post(self):
        with Stubs([message(post=None)]):
            self.assertIsNone(unsubscribe.options("account", ["m"])["m"]["one_click"])

    def test_says_when_a_message_was_unsubscribed_from(self):
        with Stubs([message(keywords={"$unsubscribed": True})]):
            self.assertTrue(unsubscribe.options("account", ["m"])["m"]["unsubscribed"])


class TestUnsubscribing(UnitTestCase):
    def test_one_click_is_posted_from_the_server_and_the_mail_marked(self):
        with Stubs([message()]) as stubs:
            self.assertEqual(unsubscribe.unsubscribe("account", "m"), "one_click")
        [(method, url, kwargs)] = stubs.posts
        self.assertEqual((method, url, kwargs["body"]), ("POST", ONE_CLICK, b"List-Unsubscribe=One-Click"))
        self.assertEqual(stubs.queued, [])
        self.assertEqual(stubs.marked, [{"m": {"keywords/$unsubscribed": True}}])

    def test_without_one_click_it_writes_from_the_address_the_mail_came_to(self):
        with Stubs([message(post=None)]) as stubs:
            self.assertEqual(unsubscribe.unsubscribe("account", "m"), "mailto")
        [queued] = stubs.queued
        self.assertEqual(queued["from_email"], "me@example.com")
        self.assertEqual(queued["recipients"][0]["email"], "leave@news.example.com")
        self.assertEqual(queued["subject"], "remove me")
        self.assertTrue(queued["destroy_after_submit"])
        self.assertEqual(stubs.posts, [])

    def test_a_refusal_fails_and_leaves_the_mail_unmarked(self):
        for stubs in (Stubs([message()], status=500), Stubs([message()], error=TimeoutError())):
            with stubs, self.assertRaises(unsubscribe.UnsubscribeFailed):
                unsubscribe.unsubscribe("account", "m")
            self.assertEqual(stubs.marked, [])

    def test_mail_in_junk_or_with_only_a_page_is_refused(self):
        for email in (
            message(keywords={"$junk": True}),
            message(urls=("https://news.example.com/p",), post=None),
        ):
            with Stubs([email]) as stubs, self.assertRaises(frappe.ValidationError):
                unsubscribe.unsubscribe("account", "m")
            self.assertEqual((stubs.posts, stubs.queued, stubs.marked), ([], [], []))
