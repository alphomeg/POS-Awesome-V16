import datetime
import importlib.util
import pathlib
import sys
import types
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]


def _install_stubs():
    posawesome_pkg = types.ModuleType("posawesome")
    posawesome_pkg.__path__ = [str(REPO_ROOT / "posawesome")]
    sys.modules.setdefault("posawesome", posawesome_pkg)

    posawesome_inner_pkg = types.ModuleType("posawesome.posawesome")
    posawesome_inner_pkg.__path__ = [str(REPO_ROOT / "posawesome" / "posawesome")]
    sys.modules.setdefault("posawesome.posawesome", posawesome_inner_pkg)

    posawesome_api_pkg = types.ModuleType("posawesome.posawesome.api")
    posawesome_api_pkg.__path__ = [str(REPO_ROOT / "posawesome" / "posawesome" / "api")]
    sys.modules.setdefault("posawesome.posawesome.api", posawesome_api_pkg)

    frappe_module = types.ModuleType("frappe")
    frappe_module._ = lambda text: text
    frappe_module.throw = lambda message: (_ for _ in ()).throw(Exception(message))
    frappe_module.whitelist = lambda *args, **kwargs: (lambda fn: fn)
    frappe_module.get_doc = lambda *args, **kwargs: None
    frappe_module.flags = types.SimpleNamespace(ignore_account_permission=False)
    frappe_module.defaults = types.SimpleNamespace(get_default=lambda fieldname: "Test Co")
    frappe_module.session = types.SimpleNamespace(user="cashier@example.com")

    class _Db:
        def __init__(self):
            self.sql_calls = []

        def get_single_value(self, doctype, fieldname):
            if doctype == "Buying Settings" and fieldname == "buying_price_list":
                return "Standard Buying"
            return None

        def get_value(self, doctype, filters, fieldname=None):
            if doctype == "Price List" and filters == "Standard Buying" and fieldname == "currency":
                return "PKR"
            if doctype == "Price List" and isinstance(filters, dict) and fieldname == "name":
                return None
            if doctype == "Supplier" and fieldname == "default_price_list":
                return None
            if doctype == "Price List" and fieldname == "buying":
                return 1
            return None

        def exists(self, doctype, name):
            return doctype == "Supplier" and name == "SUP-001"

        def has_column(self, doctype, fieldname):
            return False

        def sql(self, query, params=None, as_dict=False):
            self.sql_calls.append((query, params, as_dict))
            if "FROM `tabPurchase Invoice Item`" not in query:
                return []
            if params and len(params) > 1 and params[1] == "SUP-001":
                return [
                    {
                        "item_code": "ITEM-001",
                        "rate": 44,
                        "uom": "Nos",
                        "currency": "PKR",
                        "invoice": "PINV-SUP-1",
                        "posting_date": "2026-04-17",
                        "supplier": "SUP-001",
                    }
                ]
            return [
                {
                    "item_code": "ITEM-001",
                    "rate": 41,
                    "uom": "Nos",
                    "currency": "PKR",
                    "invoice": "PINV-ANY-1",
                    "posting_date": "2026-04-16",
                    "supplier": "SUP-XYZ",
                }
            ]

    def fake_get_all(doctype, filters=None, fields=None, **kwargs):
        if doctype == "Item Price":
            raise AssertionError("Item Price lookups should use frappe.get_list")
        return []

    def fake_get_list(doctype, filters=None, fields=None, **kwargs):
        if doctype == "Item Price":
            return []
        return []

    frappe_module.db = _Db()
    frappe_module.get_all = fake_get_all
    frappe_module.get_list = fake_get_list
    sys.modules["frappe"] = frappe_module

    frappe_utils = types.ModuleType("frappe.utils")
    frappe_utils.cint = int
    frappe_utils.flt = lambda value=0, *args, **kwargs: float(value or 0)
    frappe_utils.nowdate = lambda: "2026-04-17"
    def fake_getdate(value=None):
        if value is None:
            return datetime.date(2026, 4, 17)
        if isinstance(value, datetime.date):
            return value
        if isinstance(value, str):
            year, month, day = value.strip().split("-")
            return datetime.date(int(year), int(month), int(day))
        return value

    frappe_utils.getdate = fake_getdate
    sys.modules["frappe.utils"] = frappe_utils

    erpnext_accounts_party = types.ModuleType("erpnext.accounts.party")
    erpnext_accounts_party.get_party_account = lambda *args, **kwargs: "Creditors - TC"
    sys.modules["erpnext.accounts.party"] = erpnext_accounts_party

    for package_name in (
        "erpnext",
        "erpnext.buying",
        "erpnext.buying.doctype",
        "erpnext.buying.doctype.purchase_order",
        "erpnext.stock",
        "erpnext.stock.doctype",
        "erpnext.stock.doctype.purchase_receipt",
        "erpnext.accounts",
        "erpnext.accounts.doctype",
        "erpnext.accounts.doctype.payment_entry",
    ):
        package = types.ModuleType(package_name)
        package.__path__ = []
        sys.modules.setdefault(package_name, package)

    purchase_order_mapper = types.ModuleType(
        "erpnext.buying.doctype.purchase_order.purchase_order"
    )
    purchase_order_mapper.make_purchase_receipt = lambda *_args, **_kwargs: None
    purchase_order_mapper.make_purchase_invoice = lambda *_args, **_kwargs: None
    sys.modules[purchase_order_mapper.__name__] = purchase_order_mapper

    purchase_receipt_mapper = types.ModuleType(
        "erpnext.stock.doctype.purchase_receipt.purchase_receipt"
    )
    purchase_receipt_mapper.make_purchase_invoice = lambda *_args, **_kwargs: None
    sys.modules[purchase_receipt_mapper.__name__] = purchase_receipt_mapper

    payment_entry_mapper = types.ModuleType(
        "erpnext.accounts.doctype.payment_entry.payment_entry"
    )
    payment_entry_mapper.get_payment_entry = lambda *_args, **_kwargs: None
    sys.modules[payment_entry_mapper.__name__] = payment_entry_mapper

    utils_module = types.ModuleType("posawesome.posawesome.api.utils")
    utils_module.get_active_pos_profile = lambda: {
        "name": "POS-TEST",
        "warehouse": "Stores - TC",
        "company": "Test Co",
    }
    utils_module.get_default_warehouse = lambda company=None: "Stores - TC"
    utils_module.assert_pos_profile_write_allowed = lambda profile, company=None: profile
    sys.modules["posawesome.posawesome.api.utils"] = utils_module

    pos_access_module = types.ModuleType("posawesome.posawesome.api.pos_access")
    pos_access_module.get_authorized_pos_profile = lambda profile=None, company=None: {
        "name": "POS-TEST",
        "warehouse": "Stores - TC",
        "company": "Test Co",
        "posa_allow_purchase_order": 1,
        "posa_allow_purchase_receipt": 1,
    }
    sys.modules["posawesome.posawesome.api.pos_access"] = pos_access_module

    purchase_security = types.ModuleType("posawesome.posawesome.api.purchase_action_security")

    def run_purchase_action(**kwargs):
        result = kwargs["operation"](
            {
                "user": "manager@example.com",
                "full_name": "Purchase Manager",
                "required_role": "Purchase Manager",
            }
        )
        result.update(
            {
                "authorized_by": "manager@example.com",
                "authorized_by_name": "Purchase Manager",
                "required_role": "Purchase Manager",
                "client_request_id": kwargs["client_request_id"],
                "idempotent": False,
            }
        )
        return result

    purchase_security.run_idempotent_purchase_action = run_purchase_action
    sys.modules[purchase_security.__name__] = purchase_security


def _load_module():
    module_name = "posawesome.posawesome.api.purchase_orders"
    file_path = REPO_ROOT / "posawesome" / "posawesome" / "api" / "purchase_orders.py"
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class AttrDict(dict):
    def __getattribute__(self, key):
        if not key.startswith("__") and dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        return super().__getattribute__(key)

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc

    def __setattr__(self, key, value):
        self[key] = value


class FakeDoc(AttrDict):
    def __init__(self, data=None):
        super().__init__(data or {})
        self.setdefault("items", [])
        self.setdefault("references", [])
        self.flags = types.SimpleNamespace(ignore_permissions=False)
        self.inserted = False
        self.submitted = False

    def append(self, table, row):
        child = AttrDict(row)
        self.setdefault(table, []).append(child)
        return child

    def set(self, fieldname, value):
        self[fieldname] = value

    def insert(self):
        self.inserted = True

    def submit(self):
        self.submitted = True
        self.docstatus = 1

    def reload(self):
        return self


class TestPurchaseOrdersApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.orig_sys_modules = sys.modules.copy()
        _install_stubs()
        cls.module = _load_module()

    @classmethod
    def tearDownClass(cls):
        cls.module = None
        sys.modules.clear()
        sys.modules.update(cls.orig_sys_modules)

    def test_get_last_buying_rate_works_without_supplier(self):
        result = self.module.get_last_buying_rate(None, ["ITEM-001"])

        self.assertEqual(result["ITEM-001"]["rate"], 41)
        self.assertEqual(result["ITEM-001"]["source"], "last_invoice")
        self.assertEqual(result["ITEM-001"]["invoice"], "PINV-ANY-1")
        self.assertEqual(result["ITEM-001"]["supplier"], "SUP-XYZ")

    def test_get_last_buying_rate_prefers_supplier_specific_history(self):
        self.module.frappe.db.sql_calls.clear()

        result = self.module.get_last_buying_rate("SUP-001", ["ITEM-001"])

        self.assertEqual(result["ITEM-001"]["rate"], 44)
        self.assertEqual(result["ITEM-001"]["invoice"], "PINV-SUP-1")
        self.assertEqual(result["ITEM-001"]["supplier"], "SUP-001")
        purchase_invoice_sql = next(
            call for call in self.module.frappe.db.sql_calls if "FROM `tabPurchase Invoice Item`" in call[0]
        )
        self.assertIn("ROW_NUMBER() OVER", purchase_invoice_sql[0])

    def test_get_last_buying_rate_wraps_json_scalar_item_code_before_tuple_lookup(self):
        self.module.frappe.db.sql_calls.clear()

        result = self.module.get_last_buying_rate(None, '"ITEM-001"')

        self.assertEqual(result["ITEM-001"]["rate"], 41)
        purchase_invoice_sql = next(
            call for call in self.module.frappe.db.sql_calls if "FROM `tabPurchase Invoice Item`" in call[0]
        )
        self.assertEqual(purchase_invoice_sql[1][0], ("ITEM-001",))

    def test_get_last_buying_rate_ignores_invalid_decoded_item_code_shapes(self):
        self.module.frappe.db.sql_calls.clear()

        result = self.module.get_last_buying_rate(None, '{"bad": "shape"}')

        self.assertEqual(result, {})
        self.assertFalse(
            any("FROM `tabPurchase Invoice Item`" in call[0] for call in self.module.frappe.db.sql_calls)
        )

    def test_normalize_date_for_backend_accepts_purchase_order_display_dates(self):
        self.assertEqual(self.module._normalize_date_for_backend("29-06-2026"), "2026-06-29")
        self.assertEqual(self.module._normalize_date_for_backend("29/06/2026"), "2026-06-29")
        self.assertEqual(self.module._normalize_date_for_backend("2026-6-29"), "2026-06-29")

    def test_normalize_date_for_backend_uses_fallback_for_invalid_dates(self):
        fallback = "2026-04-17"

        self.assertEqual(self.module._normalize_date_for_backend("invalid date", fallback), fallback)
        self.assertEqual(self.module._normalize_date_for_backend("2026-02-30", fallback), fallback)

    def test_updating_purchase_items_preserves_existing_erp_row_fields(self):
        retained = AttrDict(
            {
                "name": "POI-001",
                "item_code": "ITEM-001",
                "qty": 2,
                "discount_percentage": 7.5,
                "cost_center": "Main - TC",
            }
        )
        removed = AttrDict({"name": "POI-REMOVED", "item_code": "ITEM-002", "qty": 1})
        po_doc = FakeDoc({"items": [retained, removed]})
        original_get_all = self.module.frappe.get_all
        self.module.frappe.get_all = lambda *args, **kwargs: [
            AttrDict({"name": "ITEM-001", "item_name": "Item One", "stock_uom": "Nos"})
        ]

        try:
            self.module._set_purchase_order_items(
                po_doc,
                [{"name": "POI-001", "item_code": "ITEM-001", "qty": 5, "rate": 12}],
                "Stores - TC",
                "2026-04-20",
            )
        finally:
            self.module.frappe.get_all = original_get_all

        self.assertEqual(len(po_doc.items), 1)
        self.assertIs(po_doc.items[0], retained)
        self.assertEqual(retained.qty, 5)
        self.assertEqual(retained.discount_percentage, 7.5)
        self.assertEqual(retained.cost_center, "Main - TC")

    def test_updating_purchase_items_rejects_unknown_child_row_identity(self):
        po_doc = FakeDoc(
            {"items": [AttrDict({"name": "POI-001", "item_code": "ITEM-001", "qty": 2})]}
        )

        with self.assertRaisesRegex(Exception, "no longer available"):
            self.module._set_purchase_order_items(
                po_doc,
                [{"name": "POI-OTHER", "item_code": "ITEM-001", "qty": 5, "rate": 12}],
                "Stores - TC",
                "2026-04-20",
            )

    def test_loading_draft_for_update_rejects_stale_modified_value(self):
        po_doc = FakeDoc(
            {
                "name": "PO-001",
                "company": "Test Co",
                "docstatus": 0,
                "modified": "2026-04-17 10:00:00.000000",
            }
        )
        original_exists = self.module.frappe.db.exists
        original_get_doc = self.module.frappe.get_doc
        original_entitlement = self.module.assert_purchase_entitlement
        self.module.frappe.db.exists = lambda doctype, name: doctype == "Purchase Order"
        self.module.frappe.get_doc = lambda *args, **kwargs: po_doc
        self.module.assert_purchase_entitlement = lambda _profile: {"active": True}

        try:
            with self.assertRaisesRegex(Exception, "changed after it was loaded"):
                self.module._get_purchase_order_doc(
                    {
                        "purchase_order": "PO-001",
                        "expected_modified": "2026-04-17 09:00:00.000000",
                    },
                    "Test Co",
                )
        finally:
            self.module.frappe.db.exists = original_exists
            self.module.frappe.get_doc = original_get_doc
            self.module.assert_purchase_entitlement = original_entitlement

    def test_management_submit_uses_authorized_idempotent_checkpoint(self):
        po_doc = FakeDoc(
            {
                "doctype": "Purchase Order",
                "name": "PO-001",
                "company": "Test Co",
                "docstatus": 0,
                "modified": "2026-04-17 10:00:00.000000",
                "status": "Draft",
            }
        )
        original_exists = self.module.frappe.db.exists
        original_get_doc = self.module.frappe.get_doc
        original_entitlement = self.module.assert_purchase_entitlement
        self.module.frappe.db.exists = lambda doctype, name: doctype == "Purchase Order"
        self.module.frappe.get_doc = lambda *args, **kwargs: po_doc
        self.module.assert_purchase_entitlement = lambda _profile: {"active": True}

        try:
            result = self.module.process_purchase_management_action(
                {
                    "purchase_order": "PO-001",
                    "action": "submit",
                    "pos_profile": {"name": "POS-TEST"},
                    "company": "Test Co",
                    "expected_modified": "2026-04-17 10:00:00.000000",
                    "client_request_id": "submit-request-001",
                    "authorization_pin": "1234",
                }
            )
        finally:
            self.module.frappe.db.exists = original_exists
            self.module.frappe.get_doc = original_get_doc
            self.module.assert_purchase_entitlement = original_entitlement

        self.assertTrue(po_doc.submitted)
        self.assertEqual(result["purchase_order"], "PO-001")
        self.assertEqual(result["authorized_by"], "manager@example.com")
        self.assertEqual(result["client_request_id"], "submit-request-001")

    def test_create_purchase_receipt_defaults_missing_payload_row(self):
        po_doc = AttrDict(
            {
                "name": "PO-001",
                "supplier": "SUP-001",
                "company": "Test Co",
                "currency": "PKR",
                "items": [
                    AttrDict(
                        {
                            "name": "POI-001",
                            "item_code": "ITEM-001",
                            "item_name": "Item One",
                            "qty": 2,
                            "received_qty": 0,
                            "uom": "Nos",
                            "stock_uom": "Nos",
                            "conversion_factor": 1,
                            "rate": 10,
                            "warehouse": "Stores - TC",
                            "schedule_date": "2026-04-17",
                        }
                    )
                ],
            }
        )
        receipt_doc = FakeDoc(
            {
                "doctype": "Purchase Receipt",
                "name": "PREC-001",
                "items": [AttrDict({"qty": 2, "warehouse": "Stores - TC"})],
            }
        )
        mapper = sys.modules["erpnext.buying.doctype.purchase_order.purchase_order"]
        original_mapper = mapper.make_purchase_receipt
        mapper.make_purchase_receipt = lambda source_name: receipt_doc

        try:
            receipt_name = self.module._create_purchase_receipt(
                po_doc,
                {"receive": 1, "posting_date": "2026-04-17"},
                "Stores - TC",
                "2026-04-17",
            )
        finally:
            mapper.make_purchase_receipt = original_mapper

        self.assertEqual(receipt_name, "PREC-001")
        self.assertEqual(receipt_doc.items[0].qty, 2)
        self.assertTrue(receipt_doc.inserted)
        self.assertTrue(receipt_doc.submitted)

    def test_create_purchase_invoice_defaults_missing_payload_row(self):
        po_doc = AttrDict(
            {
                "name": "PO-001",
                "supplier": "SUP-001",
                "company": "Test Co",
                "currency": "PKR",
                "items": [
                    AttrDict(
                        {
                            "name": "POI-001",
                            "item_code": "ITEM-001",
                            "item_name": "Item One",
                            "qty": 3,
                            "uom": "Nos",
                            "stock_uom": "Nos",
                            "conversion_factor": 1,
                            "rate": 10,
                            "warehouse": "Stores - TC",
                            "schedule_date": "2026-04-17",
                        }
                    )
                ],
            }
        )
        invoice_doc = FakeDoc(
            {
                "doctype": "Purchase Invoice",
                "name": "PINV-001",
                "items": [AttrDict({"qty": 3, "warehouse": "Stores - TC"})],
            }
        )
        mapper = sys.modules["erpnext.buying.doctype.purchase_order.purchase_order"]
        original_mapper = mapper.make_purchase_invoice
        mapper.make_purchase_invoice = lambda source_name: invoice_doc

        try:
            invoice_name = self.module._create_purchase_invoice(
                po_doc,
                {"invoice_date": "2026-04-17"},
                "Stores - TC",
                "2026-04-17",
            )
        finally:
            mapper.make_purchase_invoice = original_mapper

        self.assertEqual(invoice_name, "PINV-001")
        self.assertEqual(invoice_doc.items[0].qty, 3)
        self.assertTrue(invoice_doc.inserted)
        self.assertTrue(invoice_doc.submitted)

    def test_create_payment_entry_allocates_across_purchase_invoices(self):
        invoices = [
            AttrDict(
                {
                    "doctype": "Purchase Invoice",
                    "name": "PINV-001",
                    "supplier": "SUP-001",
                    "outstanding_amount": 70,
                }
            ),
            AttrDict(
                {
                    "doctype": "Purchase Invoice",
                    "name": "PINV-002",
                    "supplier": "SUP-001",
                    "outstanding_amount": 80,
                }
            ),
        ]
        payment_docs = []
        mapper = sys.modules["erpnext.accounts.doctype.payment_entry.payment_entry"]
        original_mapper = mapper.get_payment_entry

        def make_payment_entry(doctype, name, party_amount=None, **_kwargs):
            payment_doc = FakeDoc(
                {
                    "doctype": "Payment Entry",
                    "name": f"PE-{len(payment_docs) + 1:03d}",
                    "references": [
                        AttrDict(
                            {
                                "reference_doctype": doctype,
                                "reference_name": name,
                                "allocated_amount": party_amount,
                            }
                        )
                    ],
                }
            )
            payment_docs.append(payment_doc)
            return payment_doc

        mapper.get_payment_entry = make_payment_entry
        original_mop_account = self.module._get_mode_of_payment_account
        self.module._get_mode_of_payment_account = lambda _mode, _company: "Cash - TC"

        try:
            created = self.module._create_payment_entry(
                invoices,
                [{"mode_of_payment": "Cash", "amount": 120}],
                "Test Co",
                "2026-04-17",
            )
        finally:
            mapper.get_payment_entry = original_mapper
            self.module._get_mode_of_payment_account = original_mop_account

        self.assertEqual(created, ["PE-001", "PE-002"])
        self.assertEqual(
            [
                (row.reference_doctype, row.reference_name, row.allocated_amount)
                for payment_doc in payment_docs
                for row in payment_doc.references
            ],
            [
                ("Purchase Invoice", "PINV-001", 70),
                ("Purchase Invoice", "PINV-002", 50),
            ],
        )

    def test_guided_payment_requires_fully_billed_order(self):
        original_progress = self.module._get_purchase_order_progress
        self.module._get_purchase_order_progress = lambda _doc: {
            "receipt_complete": True,
            "invoice_complete": False,
            "receipt_partial": False,
            "invoice_partial": True,
        }
        try:
            with self.assertRaisesRegex(Exception, "bill in full"):
                self.module._assert_simple_purchase_lifecycle(AttrDict({}), "payment")
        finally:
            self.module._get_purchase_order_progress = original_progress

    def test_purchase_payment_mode_must_be_configured_on_profile(self):
        profile = AttrDict(
            {
                "name": "POS-TEST",
                "payments": [AttrDict({"mode_of_payment": "Cash"})],
            }
        )

        with self.assertRaisesRegex(Exception, "not available"):
            self.module._prepare_purchase_payments(
                profile,
                "Test Co",
                [{"mode_of_payment": "Bank", "amount": 50}],
                "account",
            )


if __name__ == "__main__":
    unittest.main()
