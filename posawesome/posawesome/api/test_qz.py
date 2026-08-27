import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from posawesome.posawesome.api import qz


class FakePosProfile(dict):
    def __init__(self, **values):
        super().__init__(**values)
        self.name = values.get("name", "Main POS")
        self.permission_checks = []
        self.saved = False

    def check_permission(self, permission_type):
        self.permission_checks.append(permission_type)

    def save(self):
        self.saved = True


class TestQzSilentPrintConfiguration(unittest.TestCase):
    def setUp(self):
        self.profile = FakePosProfile(
            name="Main POS",
            company="RetailMind",
            disabled=0,
            create_pos_invoice_instead_of_sales_invoice=1,
            print_format="Standard",
            posa_raw_printing=1,
        )

        def exists(doctype, filters):
            return (
                doctype == "Print Format"
                and filters.get("name") == qz.RETAILMIND_THERMAL_PRINT_FORMAT
                and filters.get("doc_type") == "POS Invoice"
                and filters.get("disabled") == 0
            )

        def throw(message, exception=None, *args, **kwargs):
            raise (exception or ValueError)(message)

        self.fake_frappe = SimpleNamespace(
            PermissionError=PermissionError,
            db=SimpleNamespace(exists=exists),
            throw=throw,
        )

    def test_manager_can_enable_safe_silent_html_settings_after_confirmed_test(self):
        with (
            patch.object(qz, "frappe", self.fake_frappe),
            patch.object(qz, "get_authenticated_pos_user", return_value="manager@example.com"),
            patch.object(qz, "user_is_pos_profile_manager", return_value=True),
            patch.object(qz, "get_authorized_pos_profile", return_value=self.profile),
        ):
            result = qz.configure_pos_profile_silent_print(
                "Main POS",
                "Front Counter Thermal 80mm",
                test_print_confirmed=1,
            )

        self.assertEqual(self.profile.permission_checks, ["write"])
        self.assertTrue(self.profile.saved)
        self.assertEqual(
            result["settings"],
            {
                "print_format": "RetailMind Thermal Receipt 80mm",
                "print_receipt_on_order_complete": 1,
                "posa_qz_printer_name": "Front Counter Thermal 80mm",
                "posa_silent_print": 1,
                "posa_open_print_in_new_tab": 0,
                "posa_raw_printing": 0,
                "posa_raw_print_width": 42,
            },
        )
        self.assertEqual(self.profile["posa_raw_printing"], 0)

    def test_non_manager_is_rejected_before_profile_lookup(self):
        profile_loader = Mock(side_effect=AssertionError("profile must not load"))
        with (
            patch.object(qz, "frappe", self.fake_frappe),
            patch.object(qz, "get_authenticated_pos_user", return_value="cashier@example.com"),
            patch.object(qz, "user_is_pos_profile_manager", return_value=False),
            patch.object(qz, "get_authorized_pos_profile", profile_loader),
        ):
            with self.assertRaisesRegex(PermissionError, "POS Profile manager"):
                qz.configure_pos_profile_silent_print(
                    "Main POS",
                    "Counter Printer",
                    test_print_confirmed=1,
                )

        profile_loader.assert_not_called()

    def test_confirmation_is_required_before_profile_lookup(self):
        profile_loader = Mock(side_effect=AssertionError("profile must not load"))
        with (
            patch.object(qz, "frappe", self.fake_frappe),
            patch.object(qz, "get_authenticated_pos_user", return_value="manager@example.com"),
            patch.object(qz, "user_is_pos_profile_manager", return_value=True),
            patch.object(qz, "get_authorized_pos_profile", profile_loader),
        ):
            with self.assertRaisesRegex(ValueError, "Confirm the 80 mm test print"):
                qz.configure_pos_profile_silent_print(
                    "Main POS",
                    "Counter Printer",
                    test_print_confirmed=0,
                )

        profile_loader.assert_not_called()

    def test_invalid_control_characters_are_rejected_without_saving(self):
        with (
            patch.object(qz, "frappe", self.fake_frappe),
            patch.object(qz, "get_authenticated_pos_user", return_value="manager@example.com"),
            patch.object(qz, "user_is_pos_profile_manager", return_value=True),
            patch.object(qz, "get_authorized_pos_profile", return_value=self.profile),
        ):
            with self.assertRaisesRegex(ValueError, "control characters"):
                qz.configure_pos_profile_silent_print(
                    "Main POS",
                    "Counter\nPrinter",
                    test_print_confirmed=1,
                )

        self.assertFalse(self.profile.saved)

    def test_existing_valid_format_is_preserved_when_retailmind_format_is_unavailable(self):
        self.profile["print_format"] = "Existing Thermal Format"

        def exists(doctype, filters):
            return doctype == "Print Format" and filters.get("name") == "Existing Thermal Format"

        self.fake_frappe.db.exists = exists
        with patch.object(qz, "frappe", self.fake_frappe):
            resolved = qz._resolve_receipt_print_format(self.profile)

        self.assertEqual(resolved, "Existing Thermal Format")


if __name__ == "__main__":
    unittest.main()
