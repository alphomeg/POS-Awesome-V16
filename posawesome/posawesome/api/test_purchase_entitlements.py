import unittest
from unittest.mock import patch
import datetime
import sys
import types

frappe_module = types.ModuleType("frappe")
frappe_module._ = lambda text: text
frappe_module.session = types.SimpleNamespace(user="cashier@example.com")
sys.modules.setdefault("frappe", frappe_module)

frappe_utils = types.ModuleType("frappe.utils")
frappe_utils.cint = lambda value=0: int(value or 0)
frappe_utils.getdate = lambda value=None: (
    datetime.date.today()
    if value is None
    else value
    if isinstance(value, datetime.date)
    else datetime.date.fromisoformat(str(value))
)
frappe_utils.nowdate = lambda: datetime.date.today().isoformat()
sys.modules.setdefault("frappe.utils", frappe_utils)

from posawesome.posawesome.api import purchase_entitlements


class TestPurchaseEntitlements(unittest.TestCase):
    def setUp(self):
        self.profile = {
            "name": "POS-TEST",
            "company": "Test Co",
            "posa_allow_purchase_order": 1,
        }

    @patch.object(purchase_entitlements, "_active_seat_count", return_value=0)
    @patch.object(purchase_entitlements.frappe, "get_single", create=True)
    def test_disabled_add_on_becomes_read_only(self, get_single, _seat_count):
        get_single.return_value = {"enabled": 0, "expires_on": None, "terminal_limit": 0}

        status = purchase_entitlements.LocalPurchaseEntitlementProvider().get_status(self.profile)

        self.assertFalse(status["active"])
        self.assertTrue(status["read_only"])
        self.assertIn("disabled", status["reason"])

    @patch.object(purchase_entitlements, "_active_seat_count", return_value=0)
    @patch.object(purchase_entitlements.frappe, "get_single", create=True)
    def test_expired_add_on_becomes_read_only(self, get_single, _seat_count):
        get_single.return_value = {
            "enabled": 1,
            "expires_on": "2000-01-01",
            "terminal_limit": 0,
        }

        status = purchase_entitlements.LocalPurchaseEntitlementProvider().get_status(self.profile)

        self.assertFalse(status["active"])
        self.assertIn("expired", status["reason"])

    @patch.object(purchase_entitlements, "_active_seat_count", return_value=2)
    @patch.object(
        purchase_entitlements,
        "_claim_terminal_seat",
        return_value=(None, "All licensed Purchasing terminal seats are currently in use."),
    )
    @patch.object(purchase_entitlements.frappe, "get_single", create=True)
    def test_terminal_limit_failure_is_read_only(self, get_single, _claim, _seat_count):
        get_single.return_value = {"enabled": 1, "expires_on": None, "terminal_limit": 2}

        status = purchase_entitlements.LocalPurchaseEntitlementProvider().get_status(
            self.profile, claim_seat=True
        )

        self.assertFalse(status["active"])
        self.assertEqual(status["active_seats"], 2)
        self.assertIn("seats", status["reason"])


if __name__ == "__main__":
    unittest.main()
