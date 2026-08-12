import copy
import json
import uuid

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime

from posawesome.posawesome.api.cashier_pin_security import (
    redact_cashier_pin_request_context,
)
from posawesome.posawesome.api.idempotency import (
    doctype_supports_client_request_id,
    find_invoice_by_client_request_id,
    set_invoice_client_request_id,
)
from posawesome.posawesome.api.invoice_processing.creation import (
    _reapply_incoming_payment_amounts,
    submit_invoice,
    trusted_invoice_shift_reassignment,
)
from posawesome.posawesome.api.utils import assert_pos_profile_write_allowed


SUPPORTED_INVOICE_DOCTYPES = {"Sales Invoice", "POS Invoice"}
DEFAULT_EDIT_WINDOW_HOURS = 24
TOP_LEVEL_EDITABLE_FIELDS = (
    "customer",
    "discount_amount",
    "additional_discount_percentage",
    "apply_discount_on",
    "due_date",
)
CHILD_ID_FIELDS = {
    "name",
    "parent",
    "parentfield",
    "parenttype",
    "creation",
    "owner",
    "modified",
    "modified_by",
    "docstatus",
    "_liked_by",
    "__last_sync_on",
}
ITEM_EDITABLE_FIELDS = {
    "item_code",
    "item_name",
    "description",
    "qty",
    "uom",
    "stock_uom",
    "conversion_factor",
    "warehouse",
    "rate",
    "price_list_rate",
    "discount_percentage",
    "discount_amount",
    "is_free_item",
    "batch_no",
    "serial_no",
    "income_account",
    "expense_account",
    "cost_center",
}
PAYMENT_EDITABLE_FIELDS = {
    "mode_of_payment",
    "amount",
    "base_amount",
    "account",
    "type",
    "default",
    "currency",
    "conversion_rate",
}


def _loads(value, default=None):
    if default is None:
        default = {}
    if value is None:
        return copy.deepcopy(default)
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return copy.deepcopy(default)


def _normalize_doctype(doctype):
    doctype = doctype or "Sales Invoice"
    if doctype not in SUPPORTED_INVOICE_DOCTYPES:
        frappe.throw(_("Submitted invoice editing supports Sales Invoice and POS Invoice only."))
    return doctype


def _has_column(doctype, fieldname):
    try:
        return bool(frappe.db.has_column(doctype, fieldname))
    except Exception:
        return False


def _meta_has_field(doctype, fieldname):
    try:
        return bool(frappe.get_meta(doctype).has_field(fieldname))
    except Exception:
        return False


def _get_profile_setting(pos_profile, fieldname, default=None):
    if not pos_profile:
        return default
    if not _meta_has_field("POS Profile", fieldname):
        return default
    value = frappe.db.get_value("POS Profile", pos_profile, fieldname)
    return default if value is None else value


def _get_edit_window_hours(pos_profile):
    raw_value = _get_profile_setting(
        pos_profile,
        "posa_submitted_invoice_edit_window_hours",
        DEFAULT_EDIT_WINDOW_HOURS,
    )
    try:
        hours = flt(raw_value)
    except Exception:
        hours = DEFAULT_EDIT_WINDOW_HOURS
    return hours if hours > 0 else DEFAULT_EDIT_WINDOW_HOURS


def _feature_enabled(pos_profile):
    return cint(_get_profile_setting(pos_profile, "posa_allow_submitted_invoice_edit", 1)) == 1


def _get_active_children(doctype, invoice_name):
    return frappe.get_all(
        doctype,
        filters={"amended_from": invoice_name, "docstatus": ["!=", 2]},
        fields=["name"],
        limit_page_length=1,
    )


def _get_root_invoice_info(doctype, doc):
    current_name = doc.name
    current = {
        "name": doc.name,
        "creation": doc.get("creation"),
        "amended_from": doc.get("amended_from"),
    }
    seen = set()
    amendment_count = 0
    while current.get("amended_from") and current["amended_from"] not in seen:
        seen.add(current_name)
        current_name = current["amended_from"]
        parent = frappe.db.get_value(
            doctype,
            current_name,
            ["name", "creation", "amended_from"],
            as_dict=True,
        )
        if not parent:
            break
        current = parent
        amendment_count += 1
    return {
        "original_invoice": current.get("name") or doc.name,
        "original_creation": current.get("creation") or doc.get("creation"),
        "amendment_count": amendment_count,
    }


def _hours_since(value):
    if not value:
        return 0
    return (now_datetime() - get_datetime(value)).total_seconds() / 3600


def _is_closed_invoice(doc):
    if _has_column(doc.doctype, "pos_closing_entry") and doc.get("pos_closing_entry"):
        return True
    if doc.doctype == "POS Invoice" and doc.get("consolidated_invoice"):
        return True
    if frappe.db.exists(
        "Sales Invoice Reference",
        {
            "parenttype": "POS Closing Shift",
            "parentfield": "pos_transactions",
            "docstatus": 1,
            "sales_invoice" if doc.doctype == "Sales Invoice" else "pos_invoice": doc.name,
        },
    ):
        return True
    return False


def _has_stored_value_settlement(doc):
    if flt(doc.get("posa_redeemed_customer_credit") or 0) > 0:
        return True
    redemptions = doc.get("gift_card_redemptions") or []
    return bool(redemptions)


def get_submitted_invoice_edit_metadata(doc, known_closed=None):
    root_info = _get_root_invoice_info(doc.doctype, doc)
    window_hours = _get_edit_window_hours(doc.get("pos_profile"))
    age_hours = _hours_since(root_info.get("original_creation"))
    can_edit = True
    reason = None

    if not _feature_enabled(doc.get("pos_profile")):
        can_edit = False
        reason = _("Submitted invoice editing is disabled for this POS Profile.")
    elif cint(doc.get("docstatus")) != 1:
        can_edit = False
        reason = _("Only submitted invoices can be edited.")
    elif cint(doc.get("is_return")):
        can_edit = False
        reason = _("Return invoices cannot be edited. Use the return workflow.")
    elif doc.get("return_against"):
        can_edit = False
        reason = _("Credit notes cannot be edited. Use the return workflow.")
    elif age_hours > window_hours:
        can_edit = False
        reason = _("This invoice is outside the {0}-hour edit window.").format(window_hours)
    elif known_closed is True or (known_closed is None and _is_closed_invoice(doc)):
        can_edit = False
        reason = _("This invoice is already linked to a submitted POS closing shift.")
    elif frappe.db.exists(doc.doctype, {"return_against": doc.name, "docstatus": 1}):
        can_edit = False
        reason = _("This invoice already has a submitted return or credit note.")
    elif _get_active_children(doc.doctype, doc.name):
        can_edit = False
        reason = _("This invoice has already been amended. Edit the latest amended invoice.")
    elif _has_stored_value_settlement(doc):
        can_edit = False
        reason = _("Invoices settled with gift cards or customer credit are not editable here.")

    return {
        "can_edit_submitted_invoice": bool(can_edit),
        "edit_block_reason": reason,
        "edit_window_hours": window_hours,
        "edit_age_hours": age_hours,
        **root_info,
    }


def assert_submitted_invoice_edit_allowed(doc, pos_profile=None, company=None):
    profile_name = pos_profile or doc.get("pos_profile")
    assert_pos_profile_write_allowed(profile_name, company=company or doc.get("company"))
    if pos_profile and doc.get("pos_profile") and doc.get("pos_profile") != pos_profile:
        frappe.throw(_("Invoice {0} does not belong to POS Profile {1}.").format(doc.name, pos_profile))
    if company and doc.get("company") and doc.get("company") != company:
        frappe.throw(_("Invoice {0} does not belong to company {1}.").format(doc.name, company))

    metadata = get_submitted_invoice_edit_metadata(doc)
    if not metadata.get("can_edit_submitted_invoice"):
        frappe.throw(metadata.get("edit_block_reason") or _("This invoice cannot be edited."))
    return metadata


def _clear_child_identity(row):
    cleaned = {}
    for key, value in (row or {}).items():
        if key in CHILD_ID_FIELDS:
            continue
        cleaned[key] = value
    return cleaned


def _safe_child_rows(rows, allowed_fields):
    cleaned = []
    for row in rows or []:
        source = _clear_child_identity(row)
        target = {field: source.get(field) for field in allowed_fields if field in source}
        cleaned.append(target)
    return cleaned


def _item_rows_from_correction(original_doc, correction):
    original_by_name = {row.name: row.as_dict() for row in original_doc.get("items") or []}
    incoming_rows = correction.get("items")
    if not isinstance(incoming_rows, list):
        incoming_rows = [row.as_dict() for row in original_doc.get("items") or []]

    result = []
    for incoming in incoming_rows:
        source = {}
        original_name = incoming.get("name")
        if original_name and original_name in original_by_name:
            source.update(original_by_name[original_name])
        source.update(incoming)
        if not source.get("item_code") or flt(source.get("qty")) == 0:
            continue
        result.append(source)
    return _safe_child_rows(result, ITEM_EDITABLE_FIELDS)


def _payment_rows_from_correction(original_doc, correction):
    incoming_rows = correction.get("payments")
    if not isinstance(incoming_rows, list):
        incoming_rows = [row.as_dict() for row in original_doc.get("payments") or []]
    return [
        row
        for row in _safe_child_rows(incoming_rows, PAYMENT_EDITABLE_FIELDS)
        if row.get("mode_of_payment")
    ]


def build_submitted_invoice_amendment_payload(original_doc, correction_data=None, client_request_id=None):
    correction = _loads(correction_data, {})
    amended_doc = frappe.copy_doc(original_doc)
    amended = amended_doc.as_dict()
    amended["doctype"] = original_doc.doctype
    amended["_force_invoice_doctype"] = original_doc.doctype
    amended["amended_from"] = original_doc.name
    amended["docstatus"] = 0
    amended.pop("name", None)
    amended.pop("status", None)
    amended.pop("pos_closing_entry", None)
    amended.pop("consolidated_invoice", None)
    amended["is_return"] = 0
    amended["return_against"] = None
    amended["pos_profile"] = original_doc.get("pos_profile")
    amended["company"] = original_doc.get("company")

    for fieldname in TOP_LEVEL_EDITABLE_FIELDS:
        if fieldname in correction:
            amended[fieldname] = correction.get(fieldname)

    amended["items"] = _item_rows_from_correction(original_doc, correction)
    amended["payments"] = _payment_rows_from_correction(original_doc, correction)

    if doctype_supports_client_request_id(original_doc.doctype):
        amended["posa_client_request_id"] = client_request_id or f"submitted-edit-{uuid.uuid4()}"

    return amended


def _preview_amended_doc(original_doc, correction_data=None):
    payload = build_submitted_invoice_amendment_payload(original_doc, correction_data)
    preview_doc = frappe.get_doc(payload)
    preview_doc.flags.ignore_permissions = True
    if hasattr(preview_doc, "set_missing_values"):
        preview_doc.set_missing_values()
        _reapply_incoming_payment_amounts(preview_doc, payload.get("payments") or [])
    if hasattr(preview_doc, "calculate_taxes_and_totals"):
        preview_doc.calculate_taxes_and_totals()
    return preview_doc


def _append_cashier_display_names(rows):
    cashier_ids = sorted(
        {
            str(row.get("posa_cashier") or "").strip()
            for row in rows or []
            if str(row.get("posa_cashier") or "").strip()
        }
    )
    cashier_names = {}
    if cashier_ids:
        users = frappe.get_all(
            "User",
            filters={"name": ["in", cashier_ids]},
            fields=["name", "full_name"],
            limit_page_length=0,
            ignore_permissions=True,
        )
        cashier_names = {
            str(user.get("name") or "").strip(): str(user.get("full_name") or "").strip()
            for user in users or []
            if str(user.get("name") or "").strip()
        }

    for row in rows or []:
        cashier_id = str(row.get("posa_cashier") or "").strip()
        row["posa_cashier_name"] = cashier_names.get(cashier_id) or cashier_id


def _get_closed_invoice_names(doctype, rows):
    invoice_names = {
        str(row.get("name") or "").strip()
        for row in rows or []
        if str(row.get("name") or "").strip()
    }
    if not invoice_names:
        return set()

    closed_names = {
        str(row.get("name") or "").strip()
        for row in rows or []
        if row.get("pos_closing_entry")
        or (doctype == "POS Invoice" and row.get("consolidated_invoice"))
    }
    remaining = sorted(invoice_names - closed_names)
    if not remaining:
        return closed_names

    link_field = "sales_invoice" if doctype == "Sales Invoice" else "pos_invoice"
    references = frappe.get_all(
        "Sales Invoice Reference",
        filters={
            "parenttype": "POS Closing Shift",
            "parentfield": "pos_transactions",
            "docstatus": 1,
            link_field: ["in", remaining],
        },
        fields=[link_field],
        limit_page_length=0,
    )
    closed_names.update(
        str(reference.get(link_field) or "").strip()
        for reference in references or []
        if str(reference.get(link_field) or "").strip()
    )
    return closed_names


@frappe.whitelist()
def list_submitted_invoices(
    doctype="Sales Invoice",
    filters=None,
    fields=None,
    order_by="posting_date desc, posting_time desc, modified desc",
    limit_page_length=0,
    pos_profile=None,
    company=None,
):
    doctype = _normalize_doctype(doctype)
    filters = _loads(filters, {})
    fields = _loads(fields, [])
    if not isinstance(filters, dict):
        frappe.throw(_("Invalid filters for submitted invoice list."))
    if not isinstance(fields, list) or not fields:
        fields = ["name", "customer", "posting_date", "grand_total", "status"]

    filters["docstatus"] = 1
    if pos_profile:
        filters["pos_profile"] = pos_profile
    if company:
        filters["company"] = company

    metadata_fields = [
        "name",
        "docstatus",
        "is_return",
        "return_against",
        "creation",
        "amended_from",
        "pos_profile",
        "company",
    ]
    if _has_column(doctype, "posa_cashier"):
        metadata_fields.append("posa_cashier")
    if _has_column(doctype, "pos_closing_entry"):
        metadata_fields.append("pos_closing_entry")
    if doctype == "POS Invoice":
        metadata_fields.append("consolidated_invoice")

    requested_fields = list(dict.fromkeys([*fields, *metadata_fields]))
    rows = frappe.get_list(
        doctype,
        filters=filters,
        fields=requested_fields,
        order_by=order_by,
        limit_page_length=cint(limit_page_length or 0),
    )
    if "posa_cashier" in requested_fields:
        _append_cashier_display_names(rows)
    closed_invoice_names = _get_closed_invoice_names(doctype, rows)
    for row in rows or []:
        row["doctype"] = doctype
        doc = frappe._dict(row)
        row.update(
            get_submitted_invoice_edit_metadata(
                doc,
                known_closed=doc.name in closed_invoice_names,
            )
        )
    return rows


@frappe.whitelist()
def get_submitted_invoice_for_edit(doctype, name, pos_profile=None, company=None):
    doctype = _normalize_doctype(doctype)
    doc = frappe.get_doc(doctype, name)
    metadata = assert_submitted_invoice_edit_allowed(doc, pos_profile=pos_profile, company=company)
    return {"invoice": doc.as_dict(), "metadata": metadata}


@frappe.whitelist()
def preview_submitted_invoice_edit(doctype, name, correction_data=None, pos_profile=None, company=None):
    doctype = _normalize_doctype(doctype)
    doc = frappe.get_doc(doctype, name)
    metadata = assert_submitted_invoice_edit_allowed(doc, pos_profile=pos_profile, company=company)
    preview_doc = _preview_amended_doc(doc, correction_data)
    return {"invoice": preview_doc.as_dict(), "metadata": metadata}


@frappe.whitelist()
def submit_submitted_invoice_edit(
    doctype,
    name,
    correction_data=None,
    client_request_id=None,
    pos_profile=None,
    company=None,
    cashier_pin=None,
):
    redact_cashier_pin_request_context()
    from posawesome.posawesome.api.pos_access import get_authorized_pos_profile

    doctype = _normalize_doctype(doctype)
    client_request_id = (client_request_id or "").strip() or f"submitted-edit-{uuid.uuid4()}"
    scoped_original = frappe.get_doc(doctype, name)
    profile_doc = get_authorized_pos_profile(
        pos_profile or scoped_original.get("pos_profile"),
        company=company or scoped_original.get("company"),
    )
    canonical_profile = profile_doc.get("name")
    canonical_company = profile_doc.get("company")
    if (
        scoped_original.get("pos_profile") != canonical_profile
        or scoped_original.get("company") != canonical_company
    ):
        frappe.throw(_("This invoice is not available for the selected POS Profile."))
    scoped_original.check_permission("read")

    existing = find_invoice_by_client_request_id(
        client_request_id,
        preferred_doctype=doctype,
        pos_profile=canonical_profile,
        company=canonical_company,
        permission_type="read",
    )
    if existing and existing.get("amended_from") == name and cint(existing.docstatus) == 1:
        return {
            "name": existing.name,
            "doctype": existing.doctype,
            "docstatus": existing.docstatus,
            "idempotent": True,
            "metadata": get_submitted_invoice_edit_metadata(existing),
        }

    savepoint = "submitted_invoice_edit"
    frappe.db.savepoint(savepoint)
    try:
        frappe.db.sql(f"select name from `tab{doctype}` where name=%s for update", name)
        original_doc = frappe.get_doc(doctype, name)
        metadata = assert_submitted_invoice_edit_allowed(
            original_doc,
            pos_profile=pos_profile,
            company=company,
        )
        payload = build_submitted_invoice_amendment_payload(
            original_doc,
            correction_data=correction_data,
            client_request_id=client_request_id,
        )
        submission_data = {"client_request_id": client_request_id}
        with trusted_invoice_shift_reassignment(
            payload,
            submission_data,
            "submitted_amendment",
        ):
            original_doc.flags.ignore_permissions = True
            frappe.flags.ignore_account_permission = True
            original_doc.cancel()

            response = submit_invoice(
                json.dumps(payload, default=str),
                json.dumps(submission_data, default=str),
                submit_in_background=False,
                cashier_pin=cashier_pin,
            )
        amended_doc = frappe.get_doc(response.get("doctype") or doctype, response.get("name"))
        set_invoice_client_request_id(amended_doc, client_request_id)
        amended_doc.db_update()
        return {
            **response,
            "original_invoice": name,
            "idempotent": True,
            "metadata": {
                **metadata,
                **get_submitted_invoice_edit_metadata(amended_doc),
            },
        }
    except Exception:
        frappe.db.rollback(save_point=savepoint)
        raise
