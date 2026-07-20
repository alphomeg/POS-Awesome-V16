import json

import frappe

from posawesome.posawesome.api.invoice_processing.creation import (
    repair_invoice_submission,
    submit_invoice,
    trusted_invoice_shift_reassignment,
)
from posawesome.posawesome.api.idempotency import (
    INVOICE_DOCTYPES,
    normalize_invoice_request_identity,
)


ALLOWED_INVOICE_DOCTYPES = frozenset(INVOICE_DOCTYPES)


def _ensure_dict(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return {}
    return dict(value or {})


def _string(value):
    return str(value or "").strip()


def _assert_allowed_invoice_payload(invoice, data):
    requested_doctypes = {
        _string(value)
        for value in (
            invoice.get("doctype"),
            invoice.get("_force_invoice_doctype"),
            data.get("doctype"),
            data.get("_force_invoice_doctype"),
        )
        if _string(value)
    }
    if not requested_doctypes:
        frappe.throw("Invoice document type is required.")
    if any(doctype not in ALLOWED_INVOICE_DOCTYPES for doctype in requested_doctypes):
        frappe.throw("Unsupported invoice document type.")
    if len(requested_doctypes) != 1:
        frappe.throw("Invoice request has conflicting document types.")
    return next(iter(requested_doctypes))


def _invoice_identity(response):
    docstatus = response.get("docstatus")
    status = response.get("status")
    if docstatus is None:
        docstatus = status
    if status is None:
        status = docstatus
    return {
        "name": _string(response.get("name")),
        "doctype": _string(response.get("doctype")),
        "docstatus": docstatus,
        "status": status,
    }


def _is_submitted_status(value):
    return value == 1 or _string(value) == "1"


def _response_status_values(response):
    return [
        response.get(fieldname)
        for fieldname in ("docstatus", "status")
        if response.get(fieldname) is not None
    ]


def _require_acknowledged_invoice(response, client_request_id, expected_doctype):
    response = _ensure_dict(response)
    response_request_id = _string(response.get("client_request_id"))
    identity = _invoice_identity(response)
    status_values = _response_status_values(response)

    if response_request_id != client_request_id:
        frappe.throw("Invoice outbox response client_request_id does not match the request.")
    if not identity["name"]:
        frappe.throw("Invoice outbox response is missing the submitted invoice name.")
    if identity["doctype"] not in ALLOWED_INVOICE_DOCTYPES:
        frappe.throw("Invoice outbox response has an unsupported invoice document type.")
    if identity["doctype"] != expected_doctype:
        frappe.throw("Invoice outbox response document type does not match the request.")
    if not status_values or not all(_is_submitted_status(value) for value in status_values):
        frappe.throw("Invoice outbox response did not confirm a submitted invoice.")

    return response, identity


@frappe.whitelist()
def submit_invoice_outbox_entry(client_request_id, invoice, data=None):
    client_request_id = (client_request_id or "").strip()
    if not client_request_id:
        frappe.throw("client_request_id is required")

    invoice_payload = _ensure_dict(invoice)
    data_payload = _ensure_dict(data)
    expected_doctype = _assert_allowed_invoice_payload(invoice_payload, data_payload)
    normalize_invoice_request_identity(
        invoice_payload,
        data_payload,
        client_request_id=client_request_id,
    )

    with trusted_invoice_shift_reassignment(
        invoice_payload,
        data_payload,
        "offline_sync",
    ):
        response = submit_invoice(
            json.dumps(invoice_payload),
            json.dumps(data_payload),
            submit_in_background=0,
        )

    response, identity = _require_acknowledged_invoice(
        response,
        client_request_id,
        expected_doctype,
    )
    return {
        "acknowledged": True,
        "client_request_id": client_request_id,
        "invoice": identity,
        "ledger_state": response.get("ledger_state"),
        "replayed": bool(response.get("replayed")),
        "idempotent": bool(response.get("idempotent", True)),
    }


@frappe.whitelist()
def reconcile_invoice_outbox_entry(
    client_request_id,
    company,
    pos_profile,
    document_type="Sales Invoice",
):
    document_type = _string(document_type)
    if document_type not in ALLOWED_INVOICE_DOCTYPES:
        frappe.throw("Unsupported invoice document type.")
    repaired = repair_invoice_submission(
        client_request_id=client_request_id,
        company=company,
        pos_profile=pos_profile,
        document_type=document_type,
    )
    repaired = _ensure_dict(repaired)
    has_submitted_indicator = any(
        _is_submitted_status(value) for value in _response_status_values(repaired)
    )
    if has_submitted_indicator:
        repaired, identity = _require_acknowledged_invoice(
            repaired,
            _string(client_request_id),
            document_type,
        )
        acknowledged = True
    else:
        identity = _invoice_identity(repaired)
        acknowledged = False
    return {
        "acknowledged": acknowledged,
        "client_request_id": client_request_id,
        "invoice": identity,
        "ledger_state": repaired.get("ledger_state"),
        "repaired": bool(repaired.get("repaired")),
        "idempotent": True,
    }


@frappe.whitelist()
def repair_invoice_outbox_entry(
    client_request_id,
    company,
    pos_profile,
    document_type="Sales Invoice",
):
    return reconcile_invoice_outbox_entry(
        client_request_id=client_request_id,
        company=company,
        pos_profile=pos_profile,
        document_type=document_type,
    )
