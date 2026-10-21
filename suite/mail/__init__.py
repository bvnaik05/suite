"""Mail's public interface and Suite Cloud email provider.

Suite Core calls is_configured before choosing its local Email Account path, then calls
send_email for configured Suite Cloud delivery. The provider preserves Suite Cloud's response
and exception types; Core owns first-party notification retries and transaction timing.
"""

from collections.abc import Mapping
from typing import Any

import frappe
from frappe import _

__all__ = ("is_configured", "send_email")


def is_configured() -> bool:
    """Return whether this site has the Suite Cloud credentials required for email delivery."""

    from suite.suite_core.utils import is_suite_cloud_configured

    return is_suite_cloud_configured()


def send_email(email_type: str, recipient: str, params: Mapping[str, Any], request_key: str) -> None:
    """Ask Suite Cloud to send one first-party email from its named template."""

    from suite.mail import suite_cloud
    from suite.suite_core.suite_email import EmailNotSentError

    result = suite_cloud.get_client().call(
        "email.send_email",
        email_type=email_type,
        recipient=recipient,
        params=params,
        request_key=request_key,
    )
    if result["status"] != "Sent":
        frappe.throw(
            _("The email to {0} was not sent: {1}").format(recipient, result.get("error")), EmailNotSentError
        )
