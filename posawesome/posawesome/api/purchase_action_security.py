from __future__ import annotations

import hashlib
import html
import json
from typing import Any, Callable

import frappe
from frappe import _
from frappe.utils import now_datetime

from posawesome.posawesome.api.employees import resolve_cashier_by_pin


PURCHASE_ACTION_ROLES = {
    "submit": "Purchase Manager",
    "receipt": "Stock Manager",
    "invoice": "Accounts Manager",
    "payment": "Accounts Manager",
}
PURCHASE_ACTION_AUDIT_EVENT = "pos_purchase_action"
PURCHASE_ACTION_AUDIT_VERSION = 1
PURCHASE_ACTION_AUDIT_PREFIX = "posa-purchase-action-"
PURCHASE_ACTION_LOCK_TIMEOUT = 120
PURCHASE_ACTION_LOCK_WAIT = 2


def _string(value: Any) -> str:
    return str(value or "").strip()


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _audit_name(pos_profile: str, purchase_order: str, action: str, client_request_id: str) -> str:
    identity = _canonical_json(
        {
            "action": action,
            "client_request_id": client_request_id,
            "event": PURCHASE_ACTION_AUDIT_EVENT,
            "pos_profile": pos_profile,
            "purchase_order": purchase_order,
            "schema_version": PURCHASE_ACTION_AUDIT_VERSION,
        }
    )
    return f"{PURCHASE_ACTION_AUDIT_PREFIX}{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"


def _encode_content(payload: dict[str, Any]) -> str:
    return f"<pre>{html.escape(_canonical_json(payload))}</pre>"


def _decode_content(content: Any) -> dict[str, Any]:
    encoded = _string(content)
    if encoded.startswith("<pre>") and encoded.endswith("</pre>"):
        encoded = encoded[5:-6]
    try:
        payload = json.loads(html.unescape(encoded))
    except (TypeError, ValueError):
        frappe.throw(_("The existing purchase action audit is invalid. Contact an administrator."))
    if not isinstance(payload, dict):
        frappe.throw(_("The existing purchase action audit is invalid. Contact an administrator."))
    return payload


def _get_existing_audit(audit_name: str, purchase_order: str):
    if not frappe.db.exists("Comment", audit_name):
        return None
    audit_doc = frappe.get_doc("Comment", audit_name)
    if (
        _string(audit_doc.get("reference_doctype")) != "Purchase Order"
        or _string(audit_doc.get("reference_name")) != purchase_order
        or _string(audit_doc.get("comment_type")) != "Info"
    ):
        frappe.throw(_("The existing purchase action audit is invalid. Contact an administrator."))
    return audit_doc, _decode_content(audit_doc.get("content"))


def _assert_replay_scope(payload: dict[str, Any], *, profile_name: str, company: str, purchase_order: str, action: str):
    expected = {
        "schema_version": PURCHASE_ACTION_AUDIT_VERSION,
        "event": PURCHASE_ACTION_AUDIT_EVENT,
        "pos_profile": profile_name,
        "company": company,
        "purchase_order": purchase_order,
        "action": action,
    }
    if any(payload.get(key) != value for key, value in expected.items()):
        frappe.throw(_("This request ID was already used for a different purchase action."))


def authorize_purchase_action(profile_doc, action: str, authorization_pin: str):
    required_role = PURCHASE_ACTION_ROLES.get(action)
    if not required_role:
        frappe.throw(_("Invalid purchase authorization action."))
    if not _string(authorization_pin):
        frappe.throw(_("Authorization PIN is required."))

    identity = resolve_cashier_by_pin(profile_doc.get("name"), authorization_pin)
    user = _string(identity.get("user"))
    roles = set(frappe.get_roles(user) or [])
    if user != "Administrator" and "System Manager" not in roles and required_role not in roles:
        frappe.throw(
            _("{0} authorization is required for this action.").format(required_role),
            getattr(frappe, "PermissionError", PermissionError),
        )
    return {
        "user": user,
        "full_name": identity.get("full_name") or user,
        "required_role": required_role,
    }


def run_idempotent_purchase_action(
    *,
    profile_doc,
    company: str,
    purchase_order: str,
    action: str,
    client_request_id: str,
    authorization_pin: str,
    operation: Callable[[dict[str, Any]], dict[str, Any]],
):
    profile_name = _string(profile_doc.get("name"))
    company = _string(company)
    purchase_order = _string(purchase_order)
    action = _string(action).lower()
    client_request_id = _string(client_request_id)
    if not client_request_id or len(client_request_id) > 140:
        frappe.throw(_("A valid Client Request ID is required."))

    audit_name = _audit_name(profile_name, purchase_order, action, client_request_id)
    existing = _get_existing_audit(audit_name, purchase_order)
    if existing:
        _audit_doc, payload = existing
        _assert_replay_scope(
            payload,
            profile_name=profile_name,
            company=company,
            purchase_order=purchase_order,
            action=action,
        )
        result = dict(payload.get("result") or {})
        result.update({"idempotent": True, "client_request_id": client_request_id})
        return result

    action_lock = frappe.cache.lock(
        frappe.cache.make_key(f"{audit_name}:lock"),
        timeout=PURCHASE_ACTION_LOCK_TIMEOUT,
        blocking_timeout=PURCHASE_ACTION_LOCK_WAIT,
    )
    if not action_lock.acquire():
        frappe.throw(_("This purchase action is already being processed. Please retry."))

    try:
        existing = _get_existing_audit(audit_name, purchase_order)
        if existing:
            _audit_doc, payload = existing
            _assert_replay_scope(
                payload,
                profile_name=profile_name,
                company=company,
                purchase_order=purchase_order,
                action=action,
            )
            result = dict(payload.get("result") or {})
            result.update({"idempotent": True, "client_request_id": client_request_id})
            return result

        authorization = authorize_purchase_action(profile_doc, action, authorization_pin)
        result = dict(operation(authorization) or {})
        result.update(
            {
                "authorized_by": authorization["user"],
                "authorized_by_name": authorization["full_name"],
                "required_role": authorization["required_role"],
            }
        )
        audit_payload = {
            "schema_version": PURCHASE_ACTION_AUDIT_VERSION,
            "event": PURCHASE_ACTION_AUDIT_EVENT,
            "client_request_id": client_request_id,
            "pos_profile": profile_name,
            "company": company,
            "purchase_order": purchase_order,
            "action": action,
            "authorized_by": authorization["user"],
            "authorized_at": now_datetime().isoformat(),
            "result": result,
        }
        audit_doc = frappe.get_doc(
            {
                "doctype": "Comment",
                "comment_type": "Info",
                "reference_doctype": "Purchase Order",
                "reference_name": purchase_order,
                "subject": _("POS purchase action: {0}").format(action),
                "content": _encode_content(audit_payload),
                "comment_by": authorization["user"],
                "comment_email": authorization["user"],
                "published": 0,
            }
        )
        audit_doc.insert(ignore_permissions=True, set_name=audit_name)
        result.update(
            {
                "audit_name": audit_doc.name,
                "client_request_id": client_request_id,
                "idempotent": False,
            }
        )
        return result
    finally:
        try:
            action_lock.release()
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"POS Awesome: failed to release purchase action lock {audit_name}",
            )
