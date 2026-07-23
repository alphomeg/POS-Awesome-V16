"""Authoritative RetailMind POS credit-sale policy and exposure helpers."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from erpnext.selling.doctype.customer.customer import (
    get_credit_limit,
    get_customer_outstanding,
)


CREDIT_SALE_FIELD = "posa_is_credit_sale"
TRUSTED_CREDIT_FLAG = "posa_trusted_credit_sale"
AMOUNT_TOLERANCE = 0.001


def _doc_value(doc, fieldname, default=None):
    if hasattr(doc, "get"):
        value = doc.get(fieldname, default)
        if value is not None:
            return value
    return getattr(doc, fieldname, default)


def _payment_amount(row):
    return max(flt(_doc_value(row, "amount", 0)), 0)


def _invoice_total(invoice_doc):
    return abs(
        flt(_doc_value(invoice_doc, "rounded_total"))
        or flt(_doc_value(invoice_doc, "grand_total"))
    )


def _settled_amount(invoice_doc, data=None):
    data = data or {}
    payment_total = sum(
        _payment_amount(row) for row in (_doc_value(invoice_doc, "payments", []) or [])
    )
    gift_card_total = sum(
        max(flt(_doc_value(row, "amount", 0)), 0)
        for row in (data.get("gift_card_redemptions") or [])
    )
    return (
        payment_total
        + max(flt(_doc_value(invoice_doc, "loyalty_amount", 0)), 0)
        + gift_card_total
        + max(flt(_doc_value(invoice_doc, "write_off_amount", 0)), 0)
    )


def get_credit_remainder(invoice_doc, data=None):
    """Return the amount that the requested sale would leave outstanding."""

    return max(_invoice_total(invoice_doc) - _settled_amount(invoice_doc, data), 0)


def _pending_pos_invoice_exposure(customer, company, exclude_invoice=None):
    if not frappe.db.has_column("POS Invoice", "consolidated_invoice"):
        return 0

    values = [customer, company]
    exclusion = ""
    if exclude_invoice:
        exclusion = " and name != %s"
        values.append(exclude_invoice)

    result = frappe.db.sql(
        f"""
        select coalesce(sum(outstanding_amount), 0)
        from `tabPOS Invoice`
        where docstatus = 1
          and customer = %s
          and company = %s
          and coalesce(consolidated_invoice, '') = ''
          and outstanding_amount > 0
          {exclusion}
        """,
        tuple(values),
    )
    return max(flt(result[0][0] if result and result[0] else 0), 0)


def get_credit_exposure(customer, company, exclude_invoice=None):
    """Return ledger exposure plus submitted POS invoices not yet consolidated."""

    ledger_exposure = max(
        flt(get_customer_outstanding(customer, company, ignore_outstanding_sales_order=False)),
        0,
    )
    pending_pos_exposure = _pending_pos_invoice_exposure(
        customer,
        company,
        exclude_invoice=exclude_invoice,
    )
    return {
        "ledger_outstanding": ledger_exposure,
        "pending_pos_outstanding": pending_pos_exposure,
        "current_outstanding": ledger_exposure + pending_pos_exposure,
    }


def _set_credit_marker(invoice_doc, enabled):
    invoice_doc.set(CREDIT_SALE_FIELD, cint(bool(enabled)))


def mark_credit_sale_trusted(invoice_doc, enabled=True):
    setattr(invoice_doc.flags, TRUSTED_CREDIT_FLAG, bool(enabled))


def is_trusted_credit_sale(invoice_doc):
    return bool(
        cint(_doc_value(invoice_doc, CREDIT_SALE_FIELD, 0))
        and getattr(invoice_doc.flags, TRUSTED_CREDIT_FLAG, False)
    )


def clear_credit_sale_authorization(invoice_doc):
    _set_credit_marker(invoice_doc, False)
    mark_credit_sale_trusted(invoice_doc, False)


def _lock_customer(customer):
    frappe.db.sql(
        "select name from `tabCustomer` where name = %s for update",
        (customer,),
    )


def _validate_credit_customer(invoice_doc, profile_doc):
    customer = str(_doc_value(invoice_doc, "customer", "") or "").strip()
    if not customer or not frappe.db.exists("Customer", customer):
        frappe.throw(_("Select an existing named customer before using Credit Sale."))

    default_customer = str(_doc_value(profile_doc, "customer", "") or "").strip()
    if default_customer and customer == default_customer:
        frappe.throw(
            _("Credit Sale is not available for the POS Profile walk-in customer.")
        )
    return customer


def authorize_credit_sale(invoice_doc, data, profile_doc=None, lock_customer=False):
    """Validate and mark an intentional POS credit sale.

    The request flag is treated only as intent. The persisted marker and trusted
    runtime flag are set exclusively after this server-side policy succeeds.
    """

    data = data or {}
    if not cint(data.get("is_credit_sale")):
        clear_credit_sale_authorization(invoice_doc)
        return None

    if cint(_doc_value(invoice_doc, "is_return", 0)):
        frappe.throw(_("Returns cannot be submitted as Credit Sales."))

    pos_profile = str(_doc_value(invoice_doc, "pos_profile", "") or "").strip()
    if not pos_profile:
        frappe.throw(_("Credit Sale is not enabled in POS Profile."))

    profile_doc = profile_doc or frappe.get_cached_doc("POS Profile", pos_profile)
    if not cint(_doc_value(profile_doc, "posa_allow_credit_sale", 0)):
        frappe.throw(_("Credit Sale is not enabled in POS Profile."))

    if flt(data.get("redeemed_customer_credit")) > 0 or cint(
        data.get("redeem_customer_credit")
    ):
        frappe.throw(
            _("Customer balance redemption cannot be combined with a Credit Sale.")
        )
    if flt(data.get("credit_change")) > 0:
        frappe.throw(_("Credit change cannot be combined with a Credit Sale."))

    customer = _validate_credit_customer(invoice_doc, profile_doc)
    company = str(_doc_value(invoice_doc, "company", "") or "").strip()
    if not company:
        frappe.throw(_("Company is required for Credit Sale validation."))

    if lock_customer:
        _lock_customer(customer)

    posting_date = getdate(_doc_value(invoice_doc, "posting_date") or nowdate())
    due_date = getdate(data.get("due_date") or _doc_value(invoice_doc, "due_date") or posting_date)
    if due_date < posting_date:
        frappe.throw(_("Credit Sale due date cannot be before the posting date."))
    invoice_doc.due_date = due_date
    data["due_date"] = str(due_date)

    credit_amount = get_credit_remainder(invoice_doc, data)
    if credit_amount <= AMOUNT_TOLERANCE:
        frappe.throw(_("Credit Sale must leave an outstanding balance."))

    exposure = get_credit_exposure(
        customer,
        company,
        exclude_invoice=_doc_value(invoice_doc, "name"),
    )
    configured_limit = flt(get_credit_limit(customer, company))
    projected_exposure = exposure["current_outstanding"] + credit_amount
    if configured_limit > 0 and projected_exposure - configured_limit > AMOUNT_TOLERANCE:
        frappe.throw(
            _(
                "Credit limit exceeded for {0}. Projected exposure is {1} and the configured limit is {2}."
            ).format(customer, projected_exposure, configured_limit)
        )

    _set_credit_marker(invoice_doc, True)
    mark_credit_sale_trusted(invoice_doc, True)
    return {
        "eligible": True,
        "reason_code": None,
        "customer": customer,
        "company": company,
        "currency": _doc_value(invoice_doc, "currency"),
        "ledger_outstanding": exposure["ledger_outstanding"],
        "pending_pos_outstanding": exposure["pending_pos_outstanding"],
        "current_outstanding": exposure["current_outstanding"],
        "configured_limit": configured_limit if configured_limit > 0 else None,
        "proposed_credit_amount": credit_amount,
        "projected_outstanding": projected_exposure,
        "available_credit": (
            max(configured_limit - projected_exposure, 0)
            if configured_limit > 0
            else None
        ),
        "due_date": str(due_date),
    }


@frappe.whitelist()
def get_credit_sale_context(
    customer,
    company,
    pos_profile,
    proposed_credit_amount=0,
    exclude_invoice=None,
):
    """Return presentation context; submission always recomputes authoritatively."""

    customer = str(customer or "").strip()
    company = str(company or "").strip()
    pos_profile = str(pos_profile or "").strip()
    proposed_credit_amount = max(flt(proposed_credit_amount), 0)

    if not pos_profile or not frappe.db.exists("POS Profile", pos_profile):
        return {"eligible": False, "reason_code": "PROFILE_NOT_FOUND"}

    profile_doc = frappe.get_cached_doc("POS Profile", pos_profile)
    if str(_doc_value(profile_doc, "company", "") or "").strip() != company:
        return {"eligible": False, "reason_code": "PROFILE_COMPANY_MISMATCH"}
    if not cint(_doc_value(profile_doc, "posa_allow_credit_sale", 0)):
        return {"eligible": False, "reason_code": "PROFILE_DISABLED"}
    if not customer:
        return {"eligible": False, "reason_code": "CUSTOMER_REQUIRED"}
    if customer == str(_doc_value(profile_doc, "customer", "") or "").strip():
        return {"eligible": False, "reason_code": "WALK_IN_CUSTOMER"}
    if not frappe.db.exists("Customer", customer):
        return {"eligible": False, "reason_code": "CUSTOMER_NOT_FOUND"}

    exposure = get_credit_exposure(customer, company, exclude_invoice=exclude_invoice)
    configured_limit = flt(get_credit_limit(customer, company))
    projected = exposure["current_outstanding"] + proposed_credit_amount
    available = (
        max(configured_limit - projected, 0) if configured_limit > 0 else None
    )
    return {
        "eligible": configured_limit <= 0 or projected <= configured_limit + AMOUNT_TOLERANCE,
        "reason_code": (
            "LIMIT_EXCEEDED"
            if configured_limit > 0 and projected > configured_limit + AMOUNT_TOLERANCE
            else None
        ),
        "customer": customer,
        "company": company,
        "ledger_outstanding": exposure["ledger_outstanding"],
        "pending_pos_outstanding": exposure["pending_pos_outstanding"],
        "current_outstanding": exposure["current_outstanding"],
        "configured_limit": configured_limit if configured_limit > 0 else None,
        "proposed_credit_amount": proposed_credit_amount,
        "projected_outstanding": projected,
        "available_credit": available,
    }
