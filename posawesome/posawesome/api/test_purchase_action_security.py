import datetime
import importlib.util
import pathlib
import sys
import types
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]


class FakeLock:
    def acquire(self):
        return True

    def release(self):
        return None


class FakeComment(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc

    def insert(self, ignore_permissions=False, set_name=None):
        self["name"] = set_name
        self._registry[set_name] = self
        return self


class TestPurchaseActionSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_modules = sys.modules.copy()
        cls.comments = {}

        posawesome_pkg = types.ModuleType("posawesome")
        posawesome_pkg.__path__ = [str(REPO_ROOT / "posawesome")]
        sys.modules["posawesome"] = posawesome_pkg
        inner_pkg = types.ModuleType("posawesome.posawesome")
        inner_pkg.__path__ = [str(REPO_ROOT / "posawesome" / "posawesome")]
        sys.modules["posawesome.posawesome"] = inner_pkg
        api_pkg = types.ModuleType("posawesome.posawesome.api")
        api_pkg.__path__ = [str(REPO_ROOT / "posawesome" / "posawesome" / "api")]
        sys.modules["posawesome.posawesome.api"] = api_pkg

        frappe = types.ModuleType("frappe")
        frappe._ = lambda text: text
        frappe.PermissionError = PermissionError
        frappe.throw = lambda message, *args, **kwargs: (_ for _ in ()).throw(
            args[0](message) if args and isinstance(args[0], type) else Exception(message)
        )
        frappe.get_roles = lambda user: ["Purchase Manager"]
        frappe.get_traceback = lambda: "traceback"
        frappe.log_error = lambda *args, **kwargs: None
        frappe.db = types.SimpleNamespace(
            exists=lambda doctype, name: doctype == "Comment" and name in cls.comments
        )
        frappe.cache = types.SimpleNamespace(
            make_key=lambda value: value,
            lock=lambda *args, **kwargs: FakeLock(),
        )

        def get_doc(doctype, name=None):
            if isinstance(doctype, dict):
                doc = FakeComment(doctype)
                doc._registry = cls.comments
                return doc
            if doctype == "Comment":
                return cls.comments[name]
            raise AssertionError((doctype, name))

        frappe.get_doc = get_doc
        sys.modules["frappe"] = frappe

        frappe_utils = types.ModuleType("frappe.utils")
        frappe_utils.now_datetime = lambda: datetime.datetime(2026, 7, 23, 12, 0, 0)
        sys.modules["frappe.utils"] = frappe_utils

        employees = types.ModuleType("posawesome.posawesome.api.employees")
        employees.resolve_cashier_by_pin = lambda profile, pin: {
            "user": "manager@example.com",
            "full_name": "Purchase Manager",
        }
        sys.modules[employees.__name__] = employees

        module_name = "posawesome.posawesome.api.purchase_action_security"
        file_path = REPO_ROOT / "posawesome" / "posawesome" / "api" / "purchase_action_security.py"
        spec = importlib.util.spec_from_file_location(module_name, file_path)
        cls.module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = cls.module
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        sys.modules.clear()
        sys.modules.update(cls.original_modules)

    def setUp(self):
        self.comments.clear()
        self.module.frappe.get_roles = lambda user: ["Purchase Manager"]

    def test_authorization_requires_the_native_role_for_the_stage(self):
        profile = {"name": "POS-TEST"}
        authorized = self.module.authorize_purchase_action(profile, "submit", "1234")
        self.assertEqual(authorized["required_role"], "Purchase Manager")

        self.module.frappe.get_roles = lambda user: ["Stock Manager"]
        with self.assertRaisesRegex(PermissionError, "Purchase Manager authorization"):
            self.module.authorize_purchase_action(profile, "submit", "1234")

    def test_idempotent_replay_returns_original_result_without_reauthorizing(self):
        calls = {"authorization": 0, "operation": 0}
        original_authorize = self.module.authorize_purchase_action

        def authorize(*args, **kwargs):
            calls["authorization"] += 1
            return {
                "user": "manager@example.com",
                "full_name": "Purchase Manager",
                "required_role": "Purchase Manager",
            }

        def operation(_authorization):
            calls["operation"] += 1
            return {"purchase_order": "PO-001", "docstatus": 1}

        self.module.authorize_purchase_action = authorize
        try:
            first = self.module.run_idempotent_purchase_action(
                profile_doc={"name": "POS-TEST"},
                company="Test Co",
                purchase_order="PO-001",
                action="submit",
                client_request_id="request-001",
                authorization_pin="1234",
                operation=operation,
            )
            second = self.module.run_idempotent_purchase_action(
                profile_doc={"name": "POS-TEST"},
                company="Test Co",
                purchase_order="PO-001",
                action="submit",
                client_request_id="request-001",
                authorization_pin="",
                operation=operation,
            )
        finally:
            self.module.authorize_purchase_action = original_authorize

        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(second["purchase_order"], "PO-001")
        self.assertEqual(calls, {"authorization": 1, "operation": 1})


if __name__ == "__main__":
    unittest.main()
