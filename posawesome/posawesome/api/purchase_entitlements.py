from __future__ import annotations

import hashlib
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, getdate, nowdate


ENTITLEMENT_DOCTYPE = "POS Purchasing Entitlement"
SEAT_AUDIT_SUBJECT = "RetailMind Purchasing Seat"
SEAT_AUDIT_PREFIX = "posa-purchase-seat-"


def _string(value: Any) -> str:
    return str(value or "").strip()


def _current_shift(profile_doc, company: str):
    shift_name = frappe.db.get_value(
        "POS Opening Shift",
        {
            "user": frappe.session.user,
            "pos_profile": profile_doc.get("name"),
            "company": company,
            "docstatus": 1,
            "status": "Open",
            "pos_closing_shift": ["is", "not set"],
        },
        "name",
        order_by="period_start_date desc",
    )
    return _string(shift_name)


def _seat_audit_name(opening_shift: str) -> str:
    digest = hashlib.sha256(opening_shift.encode("utf-8")).hexdigest()
    return f"{SEAT_AUDIT_PREFIX}{digest}"


def _active_seat_count() -> int:
    rows = frappe.db.sql(
        """
        select count(distinct opening.name) as seat_count
        from `tabPOS Opening Shift` opening
        inner join `tabComment` claim
          on claim.reference_doctype = 'POS Opening Shift'
         and claim.reference_name = opening.name
         and claim.comment_type = 'Info'
         and claim.subject = %s
        where opening.docstatus = 1
          and opening.status = 'Open'
          and ifnull(opening.pos_closing_shift, '') = ''
        """,
        (SEAT_AUDIT_SUBJECT,),
        as_dict=True,
    )
    return cint(rows[0].get("seat_count")) if rows else 0


def _claim_terminal_seat(profile_doc, company: str, terminal_limit: int):
    opening_shift = _current_shift(profile_doc, company)
    if not opening_shift:
        return None, _("Open a POS shift to use Purchasing on this terminal.")

    audit_name = _seat_audit_name(opening_shift)
    if frappe.db.exists("Comment", audit_name):
        return opening_shift, None

    claim_lock = frappe.cache.lock(
        frappe.cache.make_key("retailmind:purchasing-seat-claim"),
        timeout=30,
        blocking_timeout=2,
    )
    if not claim_lock.acquire():
        return None, _("Purchasing terminal access is being updated. Please retry.")

    try:
        if frappe.db.exists("Comment", audit_name):
            return opening_shift, None
        if terminal_limit > 0 and _active_seat_count() >= terminal_limit:
            return None, _("All licensed Purchasing terminal seats are currently in use.")

        claim = frappe.get_doc(
            {
                "doctype": "Comment",
                "comment_type": "Info",
                "reference_doctype": "POS Opening Shift",
                "reference_name": opening_shift,
                "subject": SEAT_AUDIT_SUBJECT,
                "content": _("Purchasing seat claimed for this open POS shift."),
                "comment_by": frappe.session.user,
                "comment_email": frappe.session.user,
                "published": 0,
            }
        )
        claim.insert(ignore_permissions=True, set_name=audit_name)
        return opening_shift, None
    finally:
        try:
            claim_lock.release()
        except Exception:
            frappe.log_error(frappe.get_traceback(), "POS Awesome: purchasing seat lock release failed")


class LocalPurchaseEntitlementProvider:
    provider_name = "local"

    def get_status(self, profile_doc, *, claim_seat: bool = False):
        profile_name = _string(profile_doc.get("name"))
        company = _string(profile_doc.get("company"))
        profile_enabled = bool(cint(profile_doc.get("posa_allow_purchase_order")))
        settings = frappe.get_single(ENTITLEMENT_DOCTYPE)
        enabled = profile_enabled and bool(cint(settings.get("enabled")))
        expires_on = settings.get("expires_on")
        terminal_limit = max(cint(settings.get("terminal_limit")), 0)
        reason = None
        opening_shift = None

        if not profile_enabled:
            reason = _("Purchasing is not enabled for this POS Profile.")
        elif not cint(settings.get("enabled")):
            reason = _("The Purchasing add-on is disabled.")
        elif expires_on and getdate(nowdate()) > getdate(expires_on):
            enabled = False
            reason = _("The Purchasing add-on expired on {0}.").format(expires_on)
        elif claim_seat:
            opening_shift, seat_error = _claim_terminal_seat(profile_doc, company, terminal_limit)
            if seat_error:
                enabled = False
                reason = seat_error

        return {
            "provider": self.provider_name,
            "active": bool(enabled),
            "read_only": not bool(enabled),
            "reason": reason,
            "pos_profile": profile_name,
            "company": company,
            "expires_on": str(expires_on) if expires_on else None,
            "terminal_limit": terminal_limit,
            "opening_shift": opening_shift,
            "active_seats": _active_seat_count(),
        }


def get_purchase_entitlement_provider():
    return LocalPurchaseEntitlementProvider()


def get_purchase_entitlement_status(profile_doc, *, claim_seat: bool = False):
    return get_purchase_entitlement_provider().get_status(profile_doc, claim_seat=claim_seat)


def assert_purchase_entitlement(profile_doc):
    status = get_purchase_entitlement_status(profile_doc, claim_seat=True)
    if not status.get("active"):
        frappe.throw(status.get("reason") or _("Purchasing is not available on this terminal."))
    return status
