import unittest
from unittest.mock import patch

from posawesome.posawesome.api import dashboard


class FakeProfile(dict):
    def as_dict(self):
        return dict(self)


class TestDashboardAccess(unittest.TestCase):
    def test_forged_profile_payload_is_canonicalized_before_dashboard_access(self):
        canonical_profile = FakeProfile(
            name="Main POS",
            company="RetailMind",
            posa_allow_company_dashboard_scope=0,
        )
        forged_profile = {
            "name": "Main POS",
            "company": "Victim Co",
            "posa_allow_company_dashboard_scope": 1,
        }

        with (
            patch.object(
                dashboard,
                "get_authorized_pos_profile",
                return_value=canonical_profile,
            ) as authorize_profile,
            patch.object(
                dashboard,
                "require_pos_supervisor_or_manager",
                return_value="supervisor@example.com",
            ) as require_supervisor,
        ):
            result, cashier = dashboard._get_authorized_dashboard_profile(forged_profile)

        authorize_profile.assert_called_once_with(forged_profile)
        require_supervisor.assert_called_once_with()
        self.assertEqual(cashier, "supervisor@example.com")
        self.assertEqual(result["company"], "RetailMind")
        self.assertEqual(result["posa_allow_company_dashboard_scope"], 0)

    def test_ordinary_cashier_cannot_call_dashboard_directly(self):
        canonical_profile = FakeProfile(name="Main POS", company="RetailMind")
        with (
            patch.object(
                dashboard,
                "get_authorized_pos_profile",
                return_value=canonical_profile,
            ),
            patch.object(
                dashboard,
                "require_pos_supervisor_or_manager",
                side_effect=PermissionError("A POS supervisor or manager is required"),
            ),
        ):
            with self.assertRaisesRegex(PermissionError, "POS supervisor or manager"):
                dashboard._get_authorized_dashboard_profile("Main POS")

    def test_supervisor_can_access_authorized_profile_dashboard(self):
        canonical_profile = FakeProfile(name="Main POS", company="RetailMind")

        with (
            patch.object(
                dashboard,
                "get_authorized_pos_profile",
                return_value=canonical_profile,
            ),
            patch.object(
                dashboard,
                "require_pos_supervisor_or_manager",
                return_value="supervisor@example.com",
            ) as require_supervisor,
        ):
            result, cashier = dashboard._get_authorized_dashboard_profile("Main POS")

        require_supervisor.assert_called_once_with()
        self.assertEqual(cashier, "supervisor@example.com")
        self.assertEqual(result["name"], "Main POS")

    def test_company_scope_remains_reserved_to_privileged_managers(self):
        with patch.object(dashboard, "user_is_pos_privileged_manager", return_value=False):
            self.assertFalse(dashboard._user_can_view_all_profiles("supervisor@example.com"))

        with patch.object(dashboard, "user_is_pos_privileged_manager", return_value=True):
            self.assertTrue(dashboard._user_can_view_all_profiles("manager@example.com"))


if __name__ == "__main__":
    unittest.main()
