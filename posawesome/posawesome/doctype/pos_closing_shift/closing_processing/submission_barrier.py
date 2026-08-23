import json as stdlib_json

import frappe
from frappe import _


LEDGER_DOCTYPE = "POS Invoice Submission Ledger"
SETTLED_STATE = "POST_SUBMIT_DONE"
FAILED_STATE = "FAILED"
LEDGER_PAGE_SIZE = 200
DETAIL_LIMIT = 20


def _payload_opening_shift(value):
    if not value:
        return None
    try:
        payload = stdlib_json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    return str(payload.get("posa_pos_opening_shift") or "").strip() or None


def _ledger_opening_shift(row):
    for fieldname in ("invoice_payload", "request_data"):
        opening_shift = _payload_opening_shift(row.get(fieldname))
        if opening_shift:
            return opening_shift

    document_type = str(row.get("document_type") or "").strip()
    invoice_name = str(row.get("invoice_name") or "").strip()
    if document_type in {"POS Invoice", "Sales Invoice"} and invoice_name:
        return str(
            frappe.db.get_value(
                document_type,
                invoice_name,
                "posa_pos_opening_shift",
            )
            or ""
        ).strip() or None
    return None


def _iter_unsettled_ledgers(pos_profile):
    offset = 0
    while True:
        rows = frappe.get_all(
            LEDGER_DOCTYPE,
            filters={
                "pos_profile": pos_profile,
                "state": ["!=", SETTLED_STATE],
            },
            fields=[
                "name",
                "client_request_id",
                "state",
                "document_type",
                "invoice_name",
                "invoice_payload",
                "request_data",
                "error_message",
                "modified",
            ],
            order_by="modified desc",
            start=offset,
            page_length=LEDGER_PAGE_SIZE,
        )
        if not rows:
            return
        yield from rows
        if len(rows) < LEDGER_PAGE_SIZE:
            return
        offset += len(rows)


def get_opening_shift_submission_status(pos_opening_shift, pos_profile):
    """Return durable sale-finalization state for one opening shift.

    Closing is safe only after every submission ledger for the opening reaches
    ``POST_SUBMIT_DONE``. A submitted invoice can still own asynchronous change,
    gift-card, or customer-credit work, so docstatus alone is not a sufficient
    close barrier.
    """

    pending = []
    failed = []
    opening_name = str(pos_opening_shift or "").strip()
    profile_name = str(pos_profile or "").strip()
    if not opening_name or not profile_name:
        return {
            "ready": False,
            "pending_count": 0,
            "failed_count": 0,
            "pending": [],
            "failed": [],
        }

    for row in _iter_unsettled_ledgers(profile_name):
        if _ledger_opening_shift(row) != opening_name:
            continue
        detail = {
            "ledger": row.get("name"),
            "client_request_id": row.get("client_request_id"),
            "invoice": row.get("invoice_name"),
            "document_type": row.get("document_type"),
            "state": row.get("state"),
            "modified": row.get("modified"),
        }
        if row.get("state") == FAILED_STATE:
            detail["error"] = row.get("error_message")
            failed.append(detail)
        else:
            pending.append(detail)

    return {
        "ready": not pending and not failed,
        "pending_count": len(pending),
        "failed_count": len(failed),
        "pending": pending[:DETAIL_LIMIT],
        "failed": failed[:DETAIL_LIMIT],
    }


def assert_opening_shift_submissions_settled(pos_opening_shift, pos_profile):
    status = get_opening_shift_submission_status(pos_opening_shift, pos_profile)
    if status["failed_count"]:
        frappe.throw(
            _(
                "This shift has {0} sale submission(s) requiring supervisor review. "
                "Resolve them in Device & Submission Diagnostics before closing the shift."
            ).format(status["failed_count"]),
            title=_("Shift close blocked"),
            exc=frappe.ValidationError,
        )
    if status["pending_count"]:
        frappe.throw(
            _(
                "Finishing {0} sale submission(s). Keep the POS online and try closing again in a few seconds."
            ).format(status["pending_count"]),
            title=_("Sales are still finalizing"),
            exc=frappe.ValidationError,
        )
    return status
