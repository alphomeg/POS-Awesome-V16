import datetime
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import Mock


REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_ORIGINAL_MODULES = dict(sys.modules)


def tearDownModule():
    for name in list(sys.modules):
        if name.startswith(("frappe", "posawesome")) and name not in _ORIGINAL_MODULES:
            sys.modules.pop(name, None)
    for name, module in _ORIGINAL_MODULES.items():
        if name.startswith(("frappe", "posawesome")):
            sys.modules[name] = module


class AttrDict(dict):
    __getattr__ = dict.get
    __setattr__ = dict.__setitem__


class FakeDocument(AttrDict):
    def __init__(self, **values):
        super().__init__(values)
        object.__setattr__(self, "permission_checks", [])

    def check_permission(self, permission_type):
        self.permission_checks.append(permission_type)


class FakeComment(FakeDocument):
    def __init__(self, database, **values):
        super().__init__(**values)
        object.__setattr__(self, "database", database)
        object.__setattr__(self, "flags", AttrDict())
        object.__setattr__(self, "insert_ignore_permissions", None)

    def insert(self, ignore_permissions=False, set_name=None):
        object.__setattr__(self, "insert_ignore_permissions", ignore_permissions)
        if set_name:
            self.name = set_name
            self.flags.name_set = True
        self.database.insert_attempts += 1
        if self.database.duplicate_on_next_insert:
            self.database.duplicate_on_next_insert = False
            raced = FakeComment(self.database, **dict(self))
            raced.flags.name_set = True
            self.database.comments[self.name] = raced
            raise self.database.duplicate_error()
        if self.name in self.database.comments:
            raise self.database.duplicate_error()
        self.database.comments[self.name] = self
        return self


class FakeDatabase:
    def __init__(self, duplicate_error):
        self.duplicate_error = duplicate_error
        self.reset()

    def reset(self):
        self.documents = {}
        self.comments = {}
        self.insert_attempts = 0
        self.duplicate_on_next_insert = False

    def exists(self, doctype, name):
        if doctype == "Comment":
            return name if name in self.comments else None
        return name if (doctype, name) in self.documents else None


def _load_module():
    frappe = types.ModuleType("frappe")
    frappe_utils = types.ModuleType("frappe.utils")

    class ValidationError(Exception):
        pass

    class DuplicateEntryError(Exception):
        pass

    frappe.ValidationError = ValidationError
    frappe.PermissionError = PermissionError
    frappe.DuplicateEntryError = DuplicateEntryError
    frappe._ = lambda text: text

    def throw(message, exception=None, *args, **kwargs):
        raise (exception or ValidationError)(message)

    frappe.throw = throw
    frappe.whitelist = lambda *args, **kwargs: (lambda fn: fn)
    frappe.session = types.SimpleNamespace(user="supervisor@example.test")
    frappe_utils.cint = lambda value: int(value or 0)
    frappe_utils.cstr = lambda value: "" if value is None else str(value)
    frappe_utils.now_datetime = lambda: datetime.datetime(
        2026, 7, 20, 21, 30, 0, tzinfo=datetime.timezone.utc
    )

    database = FakeDatabase(DuplicateEntryError)
    frappe.db = database

    def get_doc(*args):
        if len(args) == 1 and isinstance(args[0], dict):
            return FakeComment(database, **args[0])
        doctype, name = args
        if doctype == "Comment":
            return database.comments[name]
        return database.documents[(doctype, name)]

    frappe.get_doc = get_doc
    sys.modules["frappe"] = frappe
    sys.modules["frappe.utils"] = frappe_utils

    for package, path in {
        "posawesome": REPO_ROOT / "posawesome",
        "posawesome.posawesome": REPO_ROOT / "posawesome" / "posawesome",
        "posawesome.posawesome.api": REPO_ROOT / "posawesome" / "posawesome" / "api",
    }.items():
        package_module = types.ModuleType(package)
        package_module.__path__ = [str(path)]
        sys.modules[package] = package_module

    pos_access = types.ModuleType("posawesome.posawesome.api.pos_access")
    pos_access.require_pos_supervisor_or_manager = lambda: "supervisor@example.test"
    pos_access.get_authorized_pos_profile = lambda profile=None, company=None: AttrDict(
        name=profile or "Main POS",
        company=company or "Test Company",
    )
    sys.modules["posawesome.posawesome.api.pos_access"] = pos_access

    module_name = "posawesome.posawesome.api.manual_submission_recovery"
    spec = importlib.util.spec_from_file_location(
        module_name,
        REPO_ROOT
        / "posawesome"
        / "posawesome"
        / "api"
        / "manual_submission_recovery.py",
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    module._test_database = database
    return module


class TestManualSubmissionRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recovery = _load_module()

    def setUp(self):
        self.db = self.recovery._test_database
        self.db.reset()
        self.recovery.require_pos_supervisor_or_manager = Mock(
            return_value="supervisor@example.test"
        )
        self.recovery.get_authorized_pos_profile = Mock(
            return_value=AttrDict(name="Main POS", company="Test Company")
        )

    def args(self, **overrides):
        values = {
            "client_request_id": "request-001",
            "pos_profile": "Main POS",
            "company": "Test Company",
            "document_type": "Sales Order",
            "document_name": "SO-0001",
            "outcome": "submitted",
            "note": "Verified against the sales ledger.",
            "confirmation": "request-001",
        }
        values.update(overrides)
        return values

    def add_document(
        self,
        *,
        doctype="Sales Order",
        name="SO-0001",
        company="Test Company",
        docstatus=1,
    ):
        document = FakeDocument(
            doctype=doctype,
            name=name,
            company=company,
            docstatus=docstatus,
        )
        self.db.documents[(doctype, name)] = document
        return document

    def test_requires_supervisor_and_authorized_profile(self):
        self.recovery.require_pos_supervisor_or_manager.side_effect = PermissionError(
            "supervisor required"
        )

        with self.assertRaisesRegex(PermissionError, "supervisor required"):
            self.recovery.resolve_manual_submission_recovery(**self.args())

        self.recovery.get_authorized_pos_profile.assert_not_called()
        self.assertFalse(self.db.comments)

        self.recovery.require_pos_supervisor_or_manager.side_effect = None
        self.recovery.require_pos_supervisor_or_manager.return_value = (
            "supervisor@example.test"
        )
        self.recovery.get_authorized_pos_profile.side_effect = PermissionError(
            "profile denied"
        )
        with self.assertRaisesRegex(PermissionError, "profile denied"):
            self.recovery.resolve_manual_submission_recovery(
                **self.args(company="Forged Company")
            )
        self.recovery.get_authorized_pos_profile.assert_called_once_with(
            "Main POS", company="Forged Company"
        )
        self.assertFalse(self.db.comments)

    def test_rejects_non_exact_type_outcome_confirmation_and_blank_note(self):
        invalid_cases = (
            ({"document_type": "Sales Invoice"}, "exactly Sales Order or Quotation"),
            ({"document_type": "sales order"}, "exactly Sales Order or Quotation"),
            ({"outcome": "not submitted"}, "exactly submitted or not_submitted"),
            ({"confirmation": "request-002"}, "exact Client Request ID"),
            ({"note": "   "}, "supervisor note is required"),
        )
        for overrides, message in invalid_cases:
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex(
                    self.recovery.frappe.ValidationError, message
                ):
                    self.recovery.resolve_manual_submission_recovery(
                        **self.args(**overrides)
                    )
        self.assertFalse(self.db.comments)

    def test_submitted_requires_existing_submitted_same_company_document(self):
        with self.assertRaisesRegex(
            self.recovery.frappe.ValidationError, "Document Name is required"
        ):
            self.recovery.resolve_manual_submission_recovery(
                **self.args(document_name="")
            )
        with self.assertRaisesRegex(
            self.recovery.frappe.ValidationError, "SO-0001 was not found"
        ):
            self.recovery.resolve_manual_submission_recovery(**self.args())

        draft = self.add_document(docstatus=0)
        with self.assertRaisesRegex(
            self.recovery.frappe.ValidationError, "is not submitted"
        ):
            self.recovery.resolve_manual_submission_recovery(**self.args())
        self.assertEqual(draft.permission_checks, ["read"])

        wrong_company = self.add_document(company="Other Company")
        with self.assertRaisesRegex(
            PermissionError, "not available for the selected POS Profile"
        ):
            self.recovery.resolve_manual_submission_recovery(**self.args())
        self.assertEqual(wrong_company.permission_checks, ["read"])
        self.assertFalse(self.db.comments)

    def test_submitted_resolution_persists_exact_safe_audit_and_contract(self):
        document = self.add_document()
        note = "Checked <script>alert('unsafe')</script> & approved."

        response = self.recovery.resolve_manual_submission_recovery(
            **self.args(note=note)
        )

        self.assertEqual(
            {
                key: response[key]
                for key in (
                    "resolved",
                    "client_request_id",
                    "document_type",
                    "document_name",
                    "outcome",
                )
            },
            {
                "resolved": True,
                "client_request_id": "request-001",
                "document_type": "Sales Order",
                "document_name": "SO-0001",
                "outcome": "submitted",
            },
        )
        self.assertTrue(response["audit_name"].startswith("posa-manual-recovery-"))
        self.assertFalse(response["idempotent"])
        self.assertEqual(response["audit_evidence"]["note"], note)
        self.assertEqual(
            response["audit_evidence"]["resolved_by"],
            "supervisor@example.test",
        )
        self.assertEqual(response["audit_evidence"]["document_docstatus"], 1)
        self.assertTrue(response["audit_evidence"]["document_found"])
        self.assertEqual(document.permission_checks, ["read"])

        audit = self.db.comments[response["audit_name"]]
        self.assertEqual(audit.reference_doctype, "POS Profile")
        self.assertEqual(audit.reference_name, "Main POS")
        self.assertEqual(audit.comment_type, "Info")
        self.assertEqual(audit.comment_by, "supervisor@example.test")
        self.assertTrue(audit.flags.name_set)
        self.assertTrue(audit.insert_ignore_permissions)
        self.assertNotIn("<script>", audit.content)
        self.assertEqual(
            self.recovery._decode_audit_content(audit.content),
            response["audit_evidence"],
        )

    def test_not_submitted_rejects_conflict_and_allows_audited_attestation(self):
        self.add_document(docstatus=1)
        with self.assertRaisesRegex(
            self.recovery.frappe.ValidationError, "already exists"
        ):
            self.recovery.resolve_manual_submission_recovery(
                **self.args(outcome="not_submitted")
            )
        self.assertFalse(self.db.comments)

        for docstatus in (0, 2):
            with self.subTest(existing_docstatus=docstatus):
                self.db.documents[("Sales Order", "SO-0001")].docstatus = docstatus
                with self.assertRaisesRegex(
                    self.recovery.frappe.ValidationError,
                    "Resolve or dispose of it before retaining this cart",
                ):
                    self.recovery.resolve_manual_submission_recovery(
                        **self.args(outcome="not_submitted")
                    )
        self.assertFalse(self.db.comments)

        response = self.recovery.resolve_manual_submission_recovery(
            **self.args(
                client_request_id="request-002",
                confirmation="request-002",
                document_type="Quotation",
                document_name="",
                outcome="not_submitted",
                note="No matching quotation exists after a server-side search.",
            )
        )
        self.assertTrue(response["resolved"])
        self.assertIsNone(response["document_name"])
        self.assertFalse(response["audit_evidence"]["document_found"])
        self.assertIsNone(response["audit_evidence"]["document_docstatus"])

    def test_idempotent_retry_returns_original_audit_and_conflicts_are_rejected(self):
        self.add_document()
        first = self.recovery.resolve_manual_submission_recovery(**self.args())
        second = self.recovery.resolve_manual_submission_recovery(**self.args())

        self.assertEqual(first["audit_name"], second["audit_name"])
        self.assertEqual(first["audit_evidence"], second["audit_evidence"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(self.db.insert_attempts, 1)
        self.assertEqual(len(self.db.comments), 1)

        different_note = self.recovery.resolve_manual_submission_recovery(
            **self.args(note="A retry need not reproduce the immutable original note.")
        )
        self.assertTrue(different_note["resolved"])
        self.assertTrue(different_note["idempotent"])
        self.assertEqual(
            different_note["audit_evidence"]["note"],
            "Verified against the sales ledger.",
        )

        for overrides in (
            {"outcome": "not_submitted"},
            {"document_name": "SO-9999"},
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex(
                    self.recovery.frappe.ValidationError,
                    "already manually resolved with different evidence",
                ):
                    self.recovery.resolve_manual_submission_recovery(
                        **self.args(**overrides)
                    )
        self.assertEqual(len(self.db.comments), 1)

    def test_concurrent_duplicate_returns_the_winning_identical_audit(self):
        self.add_document()
        self.db.duplicate_on_next_insert = True

        response = self.recovery.resolve_manual_submission_recovery(**self.args())

        self.assertTrue(response["resolved"])
        self.assertTrue(response["idempotent"])
        self.assertEqual(self.db.insert_attempts, 1)
        self.assertEqual(len(self.db.comments), 1)

    def test_uses_canonical_profile_company_in_document_scope_and_audit(self):
        self.recovery.get_authorized_pos_profile.return_value = AttrDict(
            name="Canonical POS", company="Canonical Company"
        )
        document = self.add_document(company="Canonical Company")

        response = self.recovery.resolve_manual_submission_recovery(
            **self.args(pos_profile='{"name":"Canonical POS"}', company="Canonical Company")
        )

        self.recovery.get_authorized_pos_profile.assert_called_once_with(
            '{"name":"Canonical POS"}', company="Canonical Company"
        )
        self.assertEqual(response["audit_reference_name"], "Canonical POS")
        self.assertEqual(
            response["audit_evidence"]["company"], "Canonical Company"
        )
        self.assertEqual(document.permission_checks, ["read"])


if __name__ == "__main__":
    unittest.main()
