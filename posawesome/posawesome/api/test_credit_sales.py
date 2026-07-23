from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import frappe

from posawesome.posawesome.api import credit_sales
from posawesome.posawesome.api.payment_processing.data import (
    _credit_sale_is_collectible,
)
from posawesome.posawesome.doctype.pos_closing_shift.closing_processing.invoices import (
    _credit_consolidation_key,
)


class FakeInvoice:
    def __init__(self, **values):
        self.values = values
        self.flags = SimpleNamespace()

    def get(self, fieldname, default=None):
        return self.values.get(fieldname, default)

    def set(self, fieldname, value):
        self.values[fieldname] = value

    def __getattr__(self, fieldname):
        if fieldname in self.values:
            return self.values[fieldname]
        raise AttributeError(fieldname)

    def __setattr__(self, fieldname, value):
        if fieldname in {"values", "flags"}:
            object.__setattr__(self, fieldname, value)
        else:
            self.values[fieldname] = value


def make_invoice(**overrides):
    values = {
        "name": "POS-INV-0001",
        "customer": "CUST-0001",
        "company": "RetailMind",
        "pos_profile": "Retail Counter",
        "posting_date": "2026-07-23",
        "currency": "PKR",
        "rounded_total": 100,
        "grand_total": 100,
        "loyalty_amount": 0,
        "write_off_amount": 0,
        "is_return": 0,
        "payments": [],
    }
    values.update(overrides)
    return FakeInvoice(**values)


def make_profile(**overrides):
    profile = frappe._dict(
        {
            "name": "Retail Counter",
            "company": "RetailMind",
            "customer": "Walk-in Customer",
            "posa_allow_credit_sale": 1,
        }
    )
    profile.update(overrides)
    return profile


class TestCreditSaleAuthorization(TestCase):
    def authorize(self, invoice, data=None, profile=None, exposure=0, limit=0):
        with (
            patch.object(frappe.db, "exists", return_value=True),
            patch.object(
                credit_sales,
                "get_credit_exposure",
                return_value={
                    "ledger_outstanding": exposure,
                    "pending_pos_outstanding": 0,
                    "current_outstanding": exposure,
                },
            ),
            patch.object(credit_sales, "get_credit_limit", return_value=limit),
        ):
            return credit_sales.authorize_credit_sale(
                invoice,
                data or {"is_credit_sale": 1},
                profile_doc=profile or make_profile(),
            )

    def test_authorizes_part_paid_credit_and_defaults_due_date(self):
        invoice = make_invoice(payments=[frappe._dict({"amount": 25})])

        result = self.authorize(invoice, exposure=100, limit=500)

        self.assertEqual(invoice.get("posa_is_credit_sale"), 1)
        self.assertTrue(credit_sales.is_trusted_credit_sale(invoice))
        self.assertEqual(str(invoice.get("due_date")), "2026-07-23")
        self.assertEqual(result["proposed_credit_amount"], 75)
        self.assertEqual(result["projected_outstanding"], 175)

    def test_allows_credit_when_no_positive_limit_is_configured(self):
        invoice = make_invoice()

        result = self.authorize(invoice, exposure=1200, limit=0)

        self.assertIsNone(result["configured_limit"])
        self.assertEqual(result["projected_outstanding"], 1300)

    def test_rejects_walk_in_customer(self):
        invoice = make_invoice(customer="Walk-in Customer")

        with self.assertRaises(frappe.ValidationError):
            self.authorize(invoice)

    def test_rejects_projected_exposure_above_configured_limit(self):
        invoice = make_invoice(payments=[frappe._dict({"amount": 10})])

        with self.assertRaises(frappe.ValidationError):
            self.authorize(invoice, exposure=450, limit=500)

    def test_rejects_credit_request_that_is_fully_settled(self):
        invoice = make_invoice(payments=[frappe._dict({"amount": 100})])

        with self.assertRaises(frappe.ValidationError):
            self.authorize(invoice)

    def test_non_credit_request_clears_server_marker_and_trust(self):
        invoice = make_invoice(posa_is_credit_sale=1)
        credit_sales.mark_credit_sale_trusted(invoice)

        result = credit_sales.authorize_credit_sale(invoice, {"is_credit_sale": 0})

        self.assertIsNone(result)
        self.assertEqual(invoice.get("posa_is_credit_sale"), 0)
        self.assertFalse(credit_sales.is_trusted_credit_sale(invoice))


class TestCreditSaleShiftContract(TestCase):
    def test_consolidation_separates_paid_and_credit_due_dates(self):
        paid = frappe._dict(
            {
                "pos_invoice": "PI-PAID",
                "posting_date": "2026-07-23",
                "due_date": "2026-07-23",
                "outstanding_amount": 0,
            }
        )
        credit = frappe._dict(
            {
                "pos_invoice": "PI-CREDIT",
                "posting_date": "2026-07-23",
                "due_date": "2026-08-23",
                "outstanding_amount": 100,
                "posa_is_credit_sale": 1,
            }
        )

        self.assertEqual(_credit_consolidation_key(paid, {}), "paid")
        self.assertEqual(
            _credit_consolidation_key(credit, {}),
            "credit:2026-08-23",
        )

    def test_return_inherits_original_invoice_settlement_group(self):
        return_invoice = frappe._dict(
            {
                "is_return": 1,
                "return_against": "PI-CREDIT",
            }
        )

        self.assertEqual(
            _credit_consolidation_key(
                return_invoice,
                {"PI-CREDIT": "credit:2026-08-23"},
            ),
            "credit:2026-08-23",
        )

    def test_credit_collection_starts_only_after_shift_close(self):
        open_shift_credit = frappe._dict(
            {
                "posa_is_credit_sale": 1,
                "posa_pos_opening_shift": "OPEN-0001",
                "pos_closing_entry": None,
            }
        )
        closed_shift_credit = frappe._dict(
            {
                **open_shift_credit,
                "pos_closing_entry": "CLOSE-0001",
            }
        )

        self.assertFalse(_credit_sale_is_collectible(open_shift_credit))
        self.assertTrue(_credit_sale_is_collectible(closed_shift_credit))
        self.assertTrue(_credit_sale_is_collectible(frappe._dict({"posa_is_credit_sale": 0})))
