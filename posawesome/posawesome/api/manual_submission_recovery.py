from __future__ import annotations

import hashlib
import html
import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, cstr, now_datetime

from posawesome.posawesome.api.pos_access import (
    get_authorized_pos_profile,
    require_pos_supervisor_or_manager,
)


SUPPORTED_DOCUMENT_TYPES = frozenset({"Sales Order", "Quotation"})
SUPPORTED_OUTCOMES = frozenset({"submitted", "not_submitted"})

_AUDIT_EVENT = "pos_manual_submission_recovery"
_AUDIT_SCHEMA_VERSION = 1
_AUDIT_NAME_PREFIX = "posa-manual-recovery-"


def _string(value: Any) -> str:
    return cstr(value).strip()


def _document_value(document, fieldname: str):
    getter = getattr(document, "get", None)
    if callable(getter):
        return getter(fieldname)
    return getattr(document, fieldname, None)


def _permission_denied(message: str):
    frappe.throw(message, getattr(frappe, "PermissionError", PermissionError))


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _audit_name(pos_profile: str, client_request_id: str) -> str:
    identity = _canonical_json(
        {
            "client_request_id": client_request_id,
            "event": _AUDIT_EVENT,
            "pos_profile": pos_profile,
            "schema_version": _AUDIT_SCHEMA_VERSION,
        }
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return f"{_AUDIT_NAME_PREFIX}{digest}"


def _encode_audit_content(payload: dict[str, Any]) -> str:
    # Comment.content is an HTML field. Escaping the canonical JSON keeps the
    # supervisor's note inert while preserving exact, machine-readable evidence.
    return f"<pre>{html.escape(_canonical_json(payload))}</pre>"


def _decode_audit_content(content: Any) -> dict[str, Any]:
    encoded = _string(content)
    if encoded.startswith("<pre>") and encoded.endswith("</pre>"):
        encoded = encoded[5:-6]
    try:
        payload = json.loads(html.unescape(encoded))
    except (TypeError, ValueError) as exc:
        frappe.throw(
            _("The existing POS manual recovery audit is invalid. Contact an administrator.")
        )
        raise exc  # pragma: no cover - frappe.throw always raises
    if not isinstance(payload, dict):
        frappe.throw(
            _("The existing POS manual recovery audit is invalid. Contact an administrator.")
        )
    return payload


def _resolved_at() -> str:
    value = now_datetime()
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else _string(value)


def _load_scoped_document(document_type: str, document_name: str, company: str):
    if not frappe.db.exists(document_type, document_name):
        return None

    document = frappe.get_doc(document_type, document_name)
    check_permission = getattr(document, "check_permission", None)
    if callable(check_permission):
        check_permission("read")

    actual_doctype = _string(_document_value(document, "doctype"))
    actual_company = _string(_document_value(document, "company"))
    if actual_doctype != document_type or actual_company != company:
        _permission_denied(
            _("This document is not available for the selected POS Profile.")
        )
    return document


def _validate_document_resolution(
    *,
    document_type: str,
    document_name: str,
    company: str,
    outcome: str,
) -> dict[str, Any]:
    if outcome == "submitted" and not document_name:
        frappe.throw(_("Document Name is required when the outcome is submitted."))

    document = (
        _load_scoped_document(document_type, document_name, company)
        if document_name
        else None
    )
    if outcome == "submitted" and not document:
        frappe.throw(
            _("{0} {1} was not found.").format(document_type, document_name)
        )

    docstatus = cint(_document_value(document, "docstatus")) if document else None
    if outcome == "submitted" and docstatus != 1:
        frappe.throw(
            _("{0} {1} is not submitted.").format(document_type, document_name)
        )
    if outcome == "not_submitted" and document:
        frappe.throw(
            _(
                "{0} {1} already exists with document status {2}. Resolve or dispose of it before "
                "retaining this cart for retry."
            ).format(document_type, document_name, docstatus)
        )

    return {
        "document_found": bool(document),
        "document_docstatus": docstatus,
    }


def _get_existing_audit(audit_name: str, pos_profile: str):
    if not frappe.db.exists("Comment", audit_name):
        return None

    audit_doc = frappe.get_doc("Comment", audit_name)
    if (
        _string(_document_value(audit_doc, "reference_doctype")) != "POS Profile"
        or _string(_document_value(audit_doc, "reference_name")) != pos_profile
        or _string(_document_value(audit_doc, "comment_type")) != "Info"
    ):
        frappe.throw(
            _("The existing POS manual recovery audit is invalid. Contact an administrator.")
        )
    return audit_doc, _decode_audit_content(_document_value(audit_doc, "content"))


def _assert_matching_existing_audit(
    existing_payload: dict[str, Any],
    requested_payload: dict[str, Any],
    audit_name: str,
):
    immutable_fields = (
        "schema_version",
        "event",
        "client_request_id",
        "pos_profile",
        "company",
        "document_type",
        "document_name",
        "outcome",
        "confirmation",
    )
    if any(
        existing_payload.get(fieldname) != requested_payload.get(fieldname)
        for fieldname in immutable_fields
    ):
        frappe.throw(
            _(
                "This request ID was already manually resolved with different evidence in audit {0}."
            ).format(audit_name)
        )


def _build_response(audit_doc, payload: dict[str, Any], *, idempotent: bool):
    return {
        "resolved": True,
        "client_request_id": payload["client_request_id"],
        "document_type": payload["document_type"],
        "document_name": payload.get("document_name"),
        "outcome": payload["outcome"],
        "audit_name": _string(_document_value(audit_doc, "name")),
        "audit_reference_doctype": "POS Profile",
        "audit_reference_name": payload["pos_profile"],
        "audit_evidence": dict(payload),
        "idempotent": bool(idempotent),
    }


def _insert_audit(
    *,
    audit_name: str,
    pos_profile: str,
    supervisor: str,
    payload: dict[str, Any],
):
    audit_doc = frappe.get_doc(
        {
            "doctype": "Comment",
            "comment_type": "Info",
            "reference_doctype": "POS Profile",
            "reference_name": pos_profile,
            "subject": _("POS manual submission recovery: {0}").format(
                payload["client_request_id"]
            ),
            "content": _encode_audit_content(payload),
            "comment_by": supervisor,
            "comment_email": supervisor,
            "published": 0,
        }
    )
    audit_doc.insert(ignore_permissions=True, set_name=audit_name)
    persisted_payload = _decode_audit_content(_document_value(audit_doc, "content"))
    return audit_doc, persisted_payload


@frappe.whitelist()
def resolve_manual_submission_recovery(
    client_request_id=None,
    pos_profile=None,
    company=None,
    document_type=None,
    document_name=None,
    outcome=None,
    note=None,
    confirmation=None,
):
    """Resolve an ambiguous non-invoice POS submission without replaying it.

    This is deliberately a supervisor attestation endpoint. It validates a
    submitted Sales Order/Quotation when one is claimed, rejects a conflicting
    submitted document when "not submitted" is claimed, and durably records the
    exact evidence on the authorized POS Profile before returning success.
    """

    supervisor = require_pos_supervisor_or_manager()
    profile_doc = get_authorized_pos_profile(pos_profile, company=company)

    client_request_id = _string(client_request_id)
    document_type = _string(document_type)
    document_name = _string(document_name)
    outcome = _string(outcome)
    note = _string(note)
    confirmation = _string(confirmation)
    canonical_profile = _string(_document_value(profile_doc, "name"))
    canonical_company = _string(_document_value(profile_doc, "company"))

    if not canonical_profile or not canonical_company:
        frappe.throw(_("The authorized POS Profile is missing its company scope."))
    if not client_request_id:
        frappe.throw(_("Client Request ID is required."))
    if document_type not in SUPPORTED_DOCUMENT_TYPES:
        frappe.throw(
            _("Document Type must be exactly Sales Order or Quotation.")
        )
    if outcome not in SUPPORTED_OUTCOMES:
        frappe.throw(_("Outcome must be exactly submitted or not_submitted."))
    if confirmation != client_request_id:
        frappe.throw(_("Type the exact Client Request ID to confirm this resolution."))
    if not note:
        frappe.throw(_("A supervisor note is required."))

    audit_name = _audit_name(canonical_profile, client_request_id)
    requested_evidence = {
        "schema_version": _AUDIT_SCHEMA_VERSION,
        "event": _AUDIT_EVENT,
        "client_request_id": client_request_id,
        "pos_profile": canonical_profile,
        "company": canonical_company,
        "document_type": document_type,
        "document_name": document_name or None,
        "outcome": outcome,
        "note": note,
        "confirmation": confirmation,
    }

    existing = _get_existing_audit(audit_name, canonical_profile)
    if existing:
        audit_doc, existing_payload = existing
        _assert_matching_existing_audit(
            existing_payload, requested_evidence, audit_name
        )
        return _build_response(audit_doc, existing_payload, idempotent=True)

    document_evidence = _validate_document_resolution(
        document_type=document_type,
        document_name=document_name,
        company=canonical_company,
        outcome=outcome,
    )
    requested_evidence.update(document_evidence)
    requested_evidence.update(
        {
            "resolved_by": supervisor,
            "resolved_at": _resolved_at(),
        }
    )

    try:
        audit_doc, persisted_payload = _insert_audit(
            audit_name=audit_name,
            pos_profile=canonical_profile,
            supervisor=supervisor,
            payload=requested_evidence,
        )
    except frappe.DuplicateEntryError:
        # A concurrent supervisor request won the deterministic Comment name.
        existing = _get_existing_audit(audit_name, canonical_profile)
        if not existing:
            raise
        audit_doc, persisted_payload = existing
        _assert_matching_existing_audit(
            persisted_payload, requested_evidence, audit_name
        )
        return _build_response(audit_doc, persisted_payload, idempotent=True)

    return _build_response(audit_doc, persisted_payload, idempotent=False)
