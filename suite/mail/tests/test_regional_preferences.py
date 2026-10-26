"""Public signup defaults and personal provider preferences."""

from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe

from suite.mail.api.account import create_account
from suite.mail.http.preferences import regional_preferences, update_regional_preferences

OPTIONS = {
    "locales": [{"value": "en-US", "label": "English"}, {"value": "fr-FR", "label": "French"}],
    "time_zones": [{"value": "UTC", "label": "UTC"}, {"value": "Europe/Paris", "label": "Paris"}],
}


class TestRegionalPreferences(TestCase):
    def setUp(self) -> None:
        self.enterContext(patch("suite.mail.http.preferences._", side_effect=lambda value: value))

    def test_signup_supplies_defaults_and_keeps_supported_explicit_values(self) -> None:
        for supplied, site_zone, expected in [
            ({}, "Europe/Paris", ("en-US", "Europe/Paris")),
            ({}, "invalid", ("en-US", "UTC")),
            ({"locale": "invalid", "time_zone": "invalid"}, "Europe/Paris", ("en-US", "Europe/Paris")),
            ({"locale": "fr-FR", "time_zone": "UTC"}, "Europe/Paris", ("fr-FR", "UTC")),
        ]:
            with self.subTest(supplied=supplied):
                request = Mock(request_key="key", is_verified=False, account="person@example.test")
                with (
                    patch("frappe.get_last_doc", return_value=request),
                    patch("frappe.db", new=Mock()),
                    patch("suite.suite_core.storage.state"),
                    patch("suite.mail.api.account.user_context", return_value=nullcontext()),
                    patch("suite.mail.directory.get_account_metadata", return_value=OPTIONS),
                    patch("suite.mail.api.account.get_system_timezone", return_value=site_zone),
                ):
                    create_account("key", "Person", "", "password", **supplied)
                request.create_account.assert_called_once_with("Person", "", "password", *expected)

    def test_personal_settings_are_written_to_and_read_from_the_provider(self) -> None:
        stored = {"locale": "en-US", "time_zone": "UTC"}
        client = Mock()

        def call(method, **values):
            self.assertEqual(values.pop("email"), "personal@example.test")
            if method == "mail.accounts.update_account":
                stored.update(values)
            return stored

        client.call.side_effect = call
        with (
            patch("suite.mail.utils.user.get_account_email", return_value="personal@example.test"),
            patch("suite.mail.directory.get_account_metadata", return_value=OPTIONS),
            patch("suite.mail.suite_cloud.get_client", return_value=client),
        ):
            update_regional_preferences("fr-FR", "Europe/Paris")
            result = regional_preferences()
            self.assertEqual((result["locale"], result["time_zone"]), ("fr-FR", "Europe/Paris"))
            with self.assertRaises(frappe.ValidationError):
                update_regional_preferences("invalid", "UTC")
        self.assertEqual(client.call.call_count, 2)
