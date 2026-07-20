import importlib.util
import json
import pathlib
import sys
import types
import unittest
from contextlib import contextmanager

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_ORIGINAL_MODULES = dict(sys.modules)
sys.path.insert(
    0,
    str(REPO_ROOT / "posawesome" / "posawesome" / "api" / "test_support"),
)

from offline_sync_harness import install_offline_sync_package_stubs


def tearDownModule():
    for name in list(sys.modules):
        if name.startswith(("frappe", "posawesome")) and name not in _ORIGINAL_MODULES:
            sys.modules.pop(name, None)
    for name, module in _ORIGINAL_MODULES.items():
        if name.startswith(("frappe", "posawesome")):
            sys.modules[name] = module


def _install_stubs():
    install_offline_sync_package_stubs()

    frappe_module = types.ModuleType("frappe")
    frappe_module._ = lambda text: text
    frappe_module.throw = lambda message: (_ for _ in ()).throw(Exception(message))
    frappe_module.whitelist = lambda *args, **kwargs: (lambda fn: fn)
    sys.modules["frappe"] = frappe_module

    # The offline-sync harness installs namespace stubs with empty package paths,
    # so load the real shared identity helper explicitly.
    idempotency_name = "posawesome.posawesome.api.idempotency"
    idempotency_path = (
        REPO_ROOT / "posawesome" / "posawesome" / "api" / "idempotency.py"
    )
    idempotency_spec = importlib.util.spec_from_file_location(
        idempotency_name, idempotency_path
    )
    idempotency_module = importlib.util.module_from_spec(idempotency_spec)
    sys.modules[idempotency_name] = idempotency_module
    idempotency_spec.loader.exec_module(idempotency_module)

    creation_module = types.ModuleType("posawesome.posawesome.api.invoice_processing.creation")
    def submit_invoice(invoice, data, submit_in_background=0, cashier_pin=None):
        if cashier_pin is not None:
            frappe_module.throw("offline outbox must not provide cashier_pin")
        return {
            "name": "ACC-SINV-OUTBOX-0001",
            "doctype": "Sales Invoice",
            "docstatus": 1,
            "status": 1,
            "client_request_id": json.loads(invoice).get("posa_client_request_id"),
        }

    creation_module.submit_invoice = submit_invoice
    creation_module.repair_invoice_submission = lambda **kwargs: {
        "name": "ACC-SINV-OUTBOX-0001",
        "doctype": kwargs.get("document_type"),
        "docstatus": 1,
        "client_request_id": kwargs.get("client_request_id"),
        "ledger_state": "POST_SUBMIT_DONE",
        "repaired": True,
    }

    @contextmanager
    def trusted_shift(invoice, data, source):
        original = invoice.get("posa_pos_opening_shift")
        invoice["posa_pos_opening_shift"] = "POS-OPEN-CURRENT"
        data["posa_pos_opening_shift"] = "POS-OPEN-CURRENT"
        data["_posa_shift_reassignment_audit"] = {
            "source": source,
            "original_opening_shift": original,
            "assigned_opening_shift": "POS-OPEN-CURRENT",
        }
        yield data["_posa_shift_reassignment_audit"]

    creation_module.trusted_invoice_shift_reassignment = trusted_shift
    sys.modules["posawesome.posawesome.api.invoice_processing.creation"] = creation_module


def _load_module():
    module_name = "test_offline_sync_invoices_target"
    file_path = REPO_ROOT / "posawesome" / "posawesome" / "api" / "offline_sync" / "invoices.py"
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class TestOfflineSyncInvoices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _install_stubs()
        cls.module = _load_module()

    def test_submit_invoice_outbox_entry_returns_acknowledgement(self):
        response = self.module.submit_invoice_outbox_entry(
            client_request_id="outbox-fixed-001",
            invoice={
                "name": "OFFLINE-SINV-0001",
                "doctype": "Sales Invoice",
                "company": "Test Company",
                "pos_profile": "Main POS",
            },
            data={},
        )

        self.assertTrue(response["acknowledged"])
        self.assertEqual(response["client_request_id"], "outbox-fixed-001")
        self.assertEqual(response["invoice"]["name"], "ACC-SINV-OUTBOX-0001")

    def test_submit_invoice_outbox_entry_normalizes_conflicting_identity_aliases(self):
        captured = {}
        original_submit_invoice = self.module.submit_invoice

        def capture_submit(invoice, data, submit_in_background=0, cashier_pin=None):
            captured["invoice"] = json.loads(invoice)
            captured["data"] = json.loads(data)
            captured["cashier_pin"] = cashier_pin
            return {
                "name": "ACC-SINV-OUTBOX-0002",
                "doctype": "Sales Invoice",
                "docstatus": 1,
                "status": 1,
                "client_request_id": json.loads(invoice).get("posa_client_request_id"),
            }

        self.module.submit_invoice = capture_submit
        try:
            self.module.submit_invoice_outbox_entry(
                client_request_id="outbox-authoritative-002",
                invoice={
                    "doctype": "Sales Invoice",
                    "posa_client_request_id": "stale-invoice-id",
                },
                data={
                    "idempotency_key": "stale-idempotency-key",
                    "client_request_id": "stale-client-id",
                },
            )
        finally:
            self.module.submit_invoice = original_submit_invoice

        self.assertEqual(
            captured["invoice"]["posa_client_request_id"],
            "outbox-authoritative-002",
        )
        self.assertIsNone(captured["cashier_pin"])
        self.assertEqual(
            captured["data"]["idempotency_key"],
            "outbox-authoritative-002",
        )
        self.assertEqual(captured["data"]["client_request_id"], "outbox-authoritative-002")

    def test_late_offline_sync_uses_server_controlled_current_shift(self):
        captured = {}
        original_submit_invoice = self.module.submit_invoice

        def capture_submit(invoice, data, submit_in_background=0):
            captured["invoice"] = json.loads(invoice)
            captured["data"] = json.loads(data)
            return {
                "name": "ACC-SINV-OFFLINE-LATE-0001",
                "doctype": "Sales Invoice",
                "docstatus": 1,
                "status": 1,
                "client_request_id": json.loads(invoice).get("posa_client_request_id"),
            }

        self.module.submit_invoice = capture_submit
        try:
            self.module.submit_invoice_outbox_entry(
                client_request_id="offline-late-001",
                invoice={
                    "doctype": "Sales Invoice",
                    "company": "Test Company",
                    "pos_profile": "Main POS",
                    "posa_pos_opening_shift": "POS-OPEN-CLOSED",
                },
                data={},
            )
        finally:
            self.module.submit_invoice = original_submit_invoice

        self.assertEqual(
            captured["invoice"]["posa_pos_opening_shift"],
            "POS-OPEN-CURRENT",
        )
        self.assertEqual(captured["data"]["posa_pos_opening_shift"], "POS-OPEN-CURRENT")
        self.assertEqual(
            captured["data"]["_posa_shift_reassignment_audit"],
            {
                "source": "offline_sync",
                "original_opening_shift": "POS-OPEN-CLOSED",
                "assigned_opening_shift": "POS-OPEN-CURRENT",
            },
        )

    def test_submit_invoice_outbox_entry_rejects_non_invoice_document_types(self):
        calls = []
        original_submit_invoice = self.module.submit_invoice

        def capture_submit(*args, **kwargs):
            calls.append((args, kwargs))
            return {}

        self.module.submit_invoice = capture_submit
        try:
            for doctype in ("Sales Order", "Quotation"):
                with self.subTest(doctype=doctype):
                    with self.assertRaisesRegex(
                        Exception,
                        "Unsupported invoice document type",
                    ):
                        self.module.submit_invoice_outbox_entry(
                            client_request_id=f"unsupported-{doctype}",
                            invoice={"doctype": doctype},
                            data={},
                        )
        finally:
            self.module.submit_invoice = original_submit_invoice

        self.assertEqual(calls, [])

    def test_submit_invoice_outbox_entry_rejects_any_unsupported_doctype_signal(self):
        original_submit_invoice = self.module.submit_invoice
        calls = []
        self.module.submit_invoice = lambda *args, **kwargs: calls.append((args, kwargs))
        try:
            with self.assertRaisesRegex(Exception, "Unsupported invoice document type"):
                self.module.submit_invoice_outbox_entry(
                    client_request_id="mixed-doctype-001",
                    invoice={"doctype": "Sales Invoice"},
                    data={"_force_invoice_doctype": "Quotation"},
                )
        finally:
            self.module.submit_invoice = original_submit_invoice

        self.assertEqual(calls, [])

    def test_submit_invoice_outbox_entry_rejects_conflicting_allowed_doctype_signals(self):
        original_submit_invoice = self.module.submit_invoice
        calls = []
        self.module.submit_invoice = lambda *args, **kwargs: calls.append((args, kwargs))
        try:
            with self.assertRaisesRegex(Exception, "conflicting document types"):
                self.module.submit_invoice_outbox_entry(
                    client_request_id="mixed-invoice-doctype-001",
                    invoice={"doctype": "Sales Invoice"},
                    data={"_force_invoice_doctype": "POS Invoice"},
                )
        finally:
            self.module.submit_invoice = original_submit_invoice

        self.assertEqual(calls, [])

    def test_submit_invoice_outbox_entry_rejects_missing_document_type(self):
        original_submit_invoice = self.module.submit_invoice
        calls = []
        self.module.submit_invoice = lambda *args, **kwargs: calls.append((args, kwargs))
        try:
            with self.assertRaisesRegex(Exception, "Invoice document type is required"):
                self.module.submit_invoice_outbox_entry(
                    client_request_id="missing-doctype-001",
                    invoice={},
                    data={},
                )
        finally:
            self.module.submit_invoice = original_submit_invoice

        self.assertEqual(calls, [])

    def test_submit_invoice_outbox_entry_rejects_draft_response(self):
        self._assert_invalid_submit_response(
            {
                "name": "ACC-SINV-DRAFT-0001",
                "doctype": "Sales Invoice",
                "docstatus": 0,
                "status": 0,
                "client_request_id": "invalid-response-001",
            },
            "did not confirm a submitted invoice",
        )

    def test_submit_invoice_outbox_entry_rejects_empty_response_identity(self):
        self._assert_invalid_submit_response(
            {},
            "client_request_id does not match",
        )

    def test_submit_invoice_outbox_entry_rejects_empty_invoice_name(self):
        self._assert_invalid_submit_response(
            {
                "name": "   ",
                "doctype": "Sales Invoice",
                "docstatus": 1,
                "status": 1,
                "client_request_id": "invalid-response-001",
            },
            "missing the submitted invoice name",
        )

    def test_submit_invoice_outbox_entry_rejects_mismatched_response_identity(self):
        self._assert_invalid_submit_response(
            {
                "name": "ACC-SINV-MISMATCH-0001",
                "doctype": "Sales Invoice",
                "docstatus": 1,
                "status": 1,
                "client_request_id": "different-request-id",
            },
            "client_request_id does not match",
        )

    def test_submit_invoice_outbox_entry_rejects_contradictory_status_signals(self):
        self._assert_invalid_submit_response(
            {
                "name": "ACC-SINV-CONTRADICTORY-0001",
                "doctype": "Sales Invoice",
                "docstatus": 1,
                "status": 0,
                "client_request_id": "invalid-response-001",
            },
            "did not confirm a submitted invoice",
        )

    def test_submit_invoice_outbox_entry_rejects_unsupported_response_doctype(self):
        self._assert_invalid_submit_response(
            {
                "name": "SO-0001",
                "doctype": "Sales Order",
                "docstatus": 1,
                "status": 1,
                "client_request_id": "invalid-response-001",
            },
            "unsupported invoice document type",
        )

    def test_submit_invoice_outbox_entry_rejects_cross_type_acknowledgement(self):
        self._assert_invalid_submit_response(
            {
                "name": "POSINV-CROSS-TYPE-0001",
                "doctype": "POS Invoice",
                "docstatus": 1,
                "status": 1,
                "client_request_id": "invalid-response-001",
            },
            "document type does not match the request",
        )

    def _assert_invalid_submit_response(self, response, message):
        original_submit_invoice = self.module.submit_invoice
        self.module.submit_invoice = lambda *args, **kwargs: response
        try:
            with self.assertRaisesRegex(Exception, message):
                self.module.submit_invoice_outbox_entry(
                    client_request_id="invalid-response-001",
                    invoice={"doctype": "Sales Invoice"},
                    data={},
                )
        finally:
            self.module.submit_invoice = original_submit_invoice

    def test_repair_invoice_outbox_entry_delegates_to_submission_repair(self):
        response = self.module.repair_invoice_outbox_entry(
            client_request_id="outbox-fixed-001",
            company="Test Company",
            pos_profile="Main POS",
            document_type="Sales Invoice",
        )

        self.assertTrue(response["repaired"])
        self.assertEqual(response["ledger_state"], "POST_SUBMIT_DONE")

    def test_reconcile_invoice_outbox_entry_rejects_cross_type_acknowledgement(self):
        original_repair = self.module.repair_invoice_submission
        self.module.repair_invoice_submission = lambda **kwargs: {
            "name": "POSINV-CROSS-TYPE-REPAIR-0001",
            "doctype": "POS Invoice",
            "docstatus": 1,
            "status": 1,
            "client_request_id": kwargs.get("client_request_id"),
        }
        try:
            with self.assertRaisesRegex(
                Exception,
                "document type does not match the request",
            ):
                self.module.reconcile_invoice_outbox_entry(
                    client_request_id="repair-cross-type-001",
                    company="Test Company",
                    pos_profile="Main POS",
                    document_type="Sales Invoice",
                )
        finally:
            self.module.repair_invoice_submission = original_repair


if __name__ == "__main__":
    unittest.main()
