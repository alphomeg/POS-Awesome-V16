"""Server-issued, bounded authorizations for one offline cash-sale command.

The normal RetailMind POS contract requires a fresh cashier PIN for every final
sale.  This module deliberately exposes a narrower exception for explicitly
enabled profiles: while online, a cashier proves their PIN once and receives a
small batch of time-bounded, HMAC-signed tickets.  Each ticket already contains
one immutable client request id, so it cannot authorize another queued sale.

The ticket is a browser-side bearer credential, never a PIN or PIN derivative.
It is valid only for ordinary cash sales. Until the server has persisted the
command in its submission ledger, reconnect rechecks the current session,
profile access, cashier assignment, scope, expiry, amount, and payment policy.
After that durable ledger is created, an exact payload hash and the non-secret
audit preserve recovery for the original user or a POS supervisor; later policy
changes must not strand the already accepted command.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import uuid4

import frappe
from frappe import _

from posawesome.posawesome.api.cashier_pin_security import (
    redact_cashier_pin_request_context,
)
from posawesome.posawesome.api.pos_access import (
    get_authenticated_pos_user,
    get_authorized_pos_profile,
)
from posawesome.posawesome.api.terminal_state import validate_assigned_terminal_cashier


TICKET_VERSION = 2
TICKET_PURPOSE = "offline_cash_sale"
OFFLINE_CASH_SALE_AUDIT_KEY = "_posa_offline_cash_sale_audit"
OFFLINE_CASH_SALE_FAILURE_PREFIX = "POSA_OFFLINE_CASH_SALE:"
REAUTHORIZATION_REQUIRED = "requires_reauthorization"
SUPERVISOR_REVIEW_REQUIRED = "requires_supervisor_review"
# This is intentionally separate from the broad resolution.  A supervisor PIN
# can solve an ownership/reassignment review, but it cannot make a queued
# command valid after the current POS policy has disabled the feature or made
# its cash configuration impossible.  The outbox uses this stable reason to
# retain the sale for explicit back-office resolution instead of looping PIN
# prompts and retries.
CURRENT_POLICY_REJECTS_COMMAND = "current_policy_rejects_command"
MIN_TTL_MINUTES = 5
# A bounded week covers planned connectivity outages without creating an
# indefinite bearer credential. Before a server ledger exists, profile revision,
# session scope, and cashier assignment remain server-authoritative at reconnect.
MAX_TTL_MINUTES = 7 * 24 * 60
MAX_TICKETS_PER_BATCH = 25
SUPPORTED_DOCUMENT_TYPES = frozenset({"Sales Invoice", "POS Invoice"})


def _string(value: Any) -> str:
    return str(value or "").strip()


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return value in {True, 1}


def _as_positive_decimal(value: Any) -> Decimal:
    try:
        result = Decimal(str(value or "0"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")
    if not result.is_finite() or result <= 0:
        return Decimal("0")
    return result


def _as_decimal(value: Any) -> Decimal | None:
    try:
        result = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return result if result.is_finite() else None


def _is_nonzero_or_invalid_decimal(value: Any) -> bool:
    decimal_value = _as_decimal(value)
    return decimal_value is None or decimal_value != 0


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _profile_value(profile: Any, fieldname: str, default: Any = None) -> Any:
    getter = getattr(profile, "get", None)
    if callable(getter):
        return getter(fieldname, default)
    return getattr(profile, fieldname, default)


def _throw(message: str):
    frappe.throw(message, getattr(frappe, "PermissionError", PermissionError))


def _authorization_failure(
    resolution: str,
    message: str,
    *,
    reason: str | None = None,
):
    """Raise a machine-readable, non-secret offline authorization outcome.

    Frappe's RPC exception transport does not preserve application exception
    subclasses consistently.  The outbox wrapper therefore uses this narrow
    marker only to turn a definitive authorization decision into a paused
    recovery state.  It is stripped before returning an API response.
    """

    resolution_marker = resolution
    if reason:
        resolution_marker = f"{resolution}|{reason}"
    frappe.throw(
        f"{OFFLINE_CASH_SALE_FAILURE_PREFIX}{resolution_marker}:{message}",
        getattr(frappe, "PermissionError", PermissionError),
    )


def extract_offline_cash_sale_failure(error: Any) -> dict[str, str] | None:
    """Extract a safe typed recovery outcome from a Frappe exception."""

    text = _string(error)
    marker_index = text.find(OFFLINE_CASH_SALE_FAILURE_PREFIX)
    if marker_index < 0:
        return None
    marked = text[marker_index + len(OFFLINE_CASH_SALE_FAILURE_PREFIX) :]
    resolution_marker, separator, message = marked.partition(":")
    resolution, separator_reason, reason = _string(resolution_marker).partition("|")
    resolution = _string(resolution)
    if (
        not separator
        or resolution
        not in {REAUTHORIZATION_REQUIRED, SUPERVISOR_REVIEW_REQUIRED}
    ):
        return None
    outcome = {
        "resolution": resolution,
        "message": _string(message)
        or _("Offline cash-sale authorization requires review."),
    }
    if separator_reason and reason == CURRENT_POLICY_REJECTS_COMMAND:
        outcome["reason"] = reason
    return outcome


def _site_secret() -> bytes:
    """Use the per-site encryption key without ever returning it to callers."""

    candidates: list[Any] = []
    local = getattr(frappe, "local", None)
    conf = getattr(local, "conf", None)
    if isinstance(conf, dict):
        candidates.append(conf.get("encryption_key"))
    frappe_conf = getattr(frappe, "conf", None)
    if isinstance(frappe_conf, dict):
        candidates.append(frappe_conf.get("encryption_key"))

    secret = next((_string(value) for value in candidates if _string(value)), "")
    if not secret:
        _throw(_("Offline cash-sale authorization is unavailable because the site encryption key is not configured."))
    return hashlib.sha256(
        f"posawesome:offline-cash-sale:{TICKET_VERSION}:{secret}".encode("utf-8")
    ).digest()


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))


def _serialize_claims(claims: dict[str, Any]) -> bytes:
    return json.dumps(
        claims,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _sign_claims(claims: dict[str, Any]) -> str:
    encoded = _b64encode(_serialize_claims(claims))
    signature = hmac.new(
        _site_secret(), encoded.encode("ascii"), hashlib.sha256
    ).digest()
    return f"{encoded}.{_b64encode(signature)}"


def _decode_claims(ticket: Any) -> dict[str, Any]:
    raw = _string(ticket)
    if not raw or raw.count(".") != 1:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization is invalid."),
        )
    encoded, supplied_signature = raw.split(".", 1)
    expected_signature = _b64encode(
        hmac.new(_site_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(supplied_signature, expected_signature):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization is invalid."),
        )
    try:
        claims = json.loads(_b64decode(encoded).decode("utf-8"))
    except Exception:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization is invalid."),
        )
    if not isinstance(claims, dict):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization is invalid."),
        )
    return claims


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_datetime(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(_string(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _offline_cash_sale_settings(profile_doc: Any) -> dict[str, Any]:
    if not _as_bool(_profile_value(profile_doc, "posa_allow_offline_signed_cash_sales")):
        _throw(_("Offline signed cash sales are disabled for this POS Profile."))

    cash_mode = _string(_profile_value(profile_doc, "posa_cash_mode_of_payment"))
    if not cash_mode:
        _throw(_("Configure a cash Mode of Payment before enabling offline signed cash sales."))

    get_payment_type = getattr(frappe, "get_cached_value", None) or getattr(
        frappe, "get_value", None
    )
    try:
        payment_type = _string(get_payment_type("Mode of Payment", cash_mode, "type"))
    except Exception:
        payment_type = ""
    if payment_type.casefold() != "cash":
        _throw(
            _("The offline signed cash-sale payment mode must be a Cash Mode of Payment.")
        )

    profile_payment_modes = {
        _string(_profile_value(row, "mode_of_payment"))
        for row in (_profile_value(profile_doc, "payments", []) or [])
    }
    if cash_mode not in profile_payment_modes:
        _throw(
            _("The offline signed cash-sale payment mode must be assigned to this POS Profile.")
        )

    company = _string(_profile_value(profile_doc, "company"))
    company_currency = ""
    try:
        company_currency = _string(
            get_payment_type("Company", company, "default_currency")
        )
    except Exception:
        company_currency = ""
    if not company_currency:
        _throw(
            _("The POS Profile company must have a default currency before offline signed cash sales can be enabled.")
        )

    maximum_amount = _as_positive_decimal(
        _profile_value(profile_doc, "posa_offline_signed_sale_max_amount")
    )
    if maximum_amount <= 0:
        _throw(_("Configure a positive offline cash-sale maximum amount before enabling offline signed cash sales."))

    ttl = _as_int(
        _profile_value(profile_doc, "posa_offline_signed_sale_ttl_minutes"), 60
    )
    ttl = min(MAX_TTL_MINUTES, max(MIN_TTL_MINUTES, ttl))
    batch_size = _as_int(
        _profile_value(profile_doc, "posa_offline_signed_sale_ticket_batch_size"), 5
    )
    batch_size = min(MAX_TICKETS_PER_BATCH, max(1, batch_size))
    return {
        "cash_mode_of_payment": cash_mode,
        "maximum_amount": maximum_amount,
        "company_currency": company_currency,
        "ttl_minutes": ttl,
        "batch_size": batch_size,
    }


def _resolved_document_type(profile_doc: Any) -> str:
    return (
        "POS Invoice"
        if _as_bool(
            _profile_value(profile_doc, "create_pos_invoice_instead_of_sales_invoice")
        )
        else "Sales Invoice"
    )


def _profile_revision(profile_doc: Any) -> str:
    """Return the server-owned policy revision used to invalidate old tickets.

    Per-sale signing intentionally does not use optional terminal-lock state as
    invoice authority.  A POS Profile edit is an explicit policy boundary, so
    its canonical ``modified`` value must still match before a ticket can start
    a server-side submission ledger.
    """

    return _string(_profile_value(profile_doc, "modified"))


def _issue_ticket_claims(
    *,
    profile_doc: Any,
    cashier: str,
    session_user: str,
    document_type: str,
    settings: dict[str, Any],
    client_request_id: str | None = None,
    payload_hash: str | None = None,
    reauthorized_from_ticket_id: str | None = None,
    reauthorization_level: str | None = None,
) -> dict[str, Any]:
    now = _utcnow()
    expiry = now + timedelta(minutes=settings["ttl_minutes"])
    claims = {
        "v": TICKET_VERSION,
        "purpose": TICKET_PURPOSE,
        "ticket_id": secrets.token_urlsafe(24),
        "client_request_id": _string(client_request_id) or f"offline-{uuid4()}",
        "cashier": cashier,
        "session_user": session_user,
        "document_type": document_type,
        "pos_profile": _string(_profile_value(profile_doc, "name")),
        "company": _string(_profile_value(profile_doc, "company")),
        "profile_revision": _profile_revision(profile_doc),
        "cash_mode_of_payment": settings["cash_mode_of_payment"],
        "maximum_amount": str(settings["maximum_amount"]),
        "company_currency": settings["company_currency"],
        "issued_at": now.isoformat(),
        "expires_at": expiry.isoformat(),
    }
    if _string(payload_hash):
        claims["payload_hash"] = _string(payload_hash)
    if _string(reauthorized_from_ticket_id):
        claims["reauthorized_from_ticket_id"] = _string(
            reauthorized_from_ticket_id
        )
    if _string(reauthorization_level):
        claims["reauthorization_level"] = _string(reauthorization_level)
    return claims


def _ticket_response(claims: dict[str, Any]) -> dict[str, str]:
    return {
        "authorization": _sign_claims(claims),
        "client_request_id": _string(claims.get("client_request_id")),
        "expires_at": _string(claims.get("expires_at")),
        "cashier": _string(claims.get("cashier")),
        # This is an authenticated user identity, not a bearer secret. The
        # browser uses it only to route a supervisor-approved recovery back to
        # the session that received the fresh signed ticket.
        "owner_user": _string(claims.get("session_user")),
        "cash_mode_of_payment": _string(claims.get("cash_mode_of_payment")),
        "maximum_amount": str(_as_positive_decimal(claims.get("maximum_amount"))),
        "company_currency": _string(claims.get("company_currency")),
        "document_type": _string(claims.get("document_type")),
    }


@frappe.whitelist(methods=["POST"])
def issue_offline_cash_sale_authorizations(
    pos_profile=None,
    pin=None,
    requested_count=None,
    document_type=None,
):
    """Verify a PIN online and mint a bounded, scoped ticket batch."""

    redact_cashier_pin_request_context()
    profile_doc = get_authorized_pos_profile(pos_profile)
    settings = _offline_cash_sale_settings(profile_doc)

    from posawesome.posawesome.api.employees import resolve_cashier_by_pin

    resolved = resolve_cashier_by_pin(pos_profile=profile_doc, pin=pin)
    cashier = validate_assigned_terminal_cashier(
        _string(_profile_value(profile_doc, "name")),
        _string((resolved or {}).get("user")),
    )
    session_user = _string(get_authenticated_pos_user())
    if not session_user:
        _throw(_("A valid POS session is required to prepare offline cash sales."))
    resolved_document_type = _resolved_document_type(profile_doc)
    requested_document_type = _string(document_type)
    if requested_document_type and requested_document_type != resolved_document_type:
        _throw(
            _("Offline cash-sale authorizations only support this POS Profile's configured invoice type.")
        )
    count = _as_int(requested_count, settings["batch_size"])
    if count < 1 or count > settings["batch_size"]:
        _throw(
            _("Offline cash-sale authorization count must be between 1 and {0}.").format(
                settings["batch_size"]
            )
        )

    tickets = []
    for _index in range(count):
        claims = _issue_ticket_claims(
            profile_doc=profile_doc,
            cashier=cashier,
            session_user=session_user,
            document_type=resolved_document_type,
            settings=settings,
        )
        tickets.append(_ticket_response(claims))
    return {
        "tickets": tickets,
        "expires_at": tickets[0]["expires_at"] if tickets else None,
        "cashier": cashier,
        "cash_mode_of_payment": settings["cash_mode_of_payment"],
        "maximum_amount": str(settings["maximum_amount"]),
        "company_currency": settings["company_currency"],
        "document_type": resolved_document_type,
    }


_PAYLOAD_TRANSIENT_KEYS = {
    "cashier_pin",
    "cashierPin",
    "pin",
    "offline_sale_authorization",
    "offlineSaleAuthorization",
    "_posa_offline_sale_authorization",
    OFFLINE_CASH_SALE_AUDIT_KEY,
    # Delayed offline recovery deliberately reassigns an invoice to the
    # currently-open shift on the server.  These are server-owned recovery
    # transport values, not part of the cashier-approved financial command.
    "posa_pos_opening_shift",
    "_posa_shift_reassignment_audit",
}


def _as_payload_dict(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            _authorization_failure(
                SUPERVISOR_REVIEW_REQUIRED,
                _("The queued offline sale has an invalid {0} payload.").format(label),
            )
    if not isinstance(value, dict):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale has an invalid {0} payload.").format(label),
        )
    return dict(value)


def _canonical_payload_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _canonical_payload_value(child)
            for key, child in value.items()
            if str(key) not in _PAYLOAD_TRANSIENT_KEYS
        }
    if isinstance(value, list):
        return [_canonical_payload_value(child) for child in value]
    return value


def offline_cash_sale_payload_hash(invoice: Any, data: Any) -> str:
    """Hash the immutable client command without retaining any credential.

    A reauthorization happens only after a queued command already exists in
    IndexedDB.  Binding the replacement ticket to that exact command prevents
    a recovery UI from silently approving a different cart under the same
    idempotency key.
    """

    canonical = {
        "invoice": _canonical_payload_value(invoice if isinstance(invoice, dict) else {}),
        "data": _canonical_payload_value(data if isinstance(data, dict) else {}),
    }
    serialized = json.dumps(
        canonical,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _normalize_reauthorization_payload(
    invoice: Any,
    data: Any,
    client_request_id: str,
    document_type: str,
    profile_doc: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    invoice_payload = _as_payload_dict(invoice, _("invoice"))
    data_payload = _as_payload_dict(data, _("payment"))
    profile_name = _string(_profile_value(profile_doc, "name"))
    company = _string(_profile_value(profile_doc, "company"))
    document_signals = {
        _string(value)
        for value in (
            invoice_payload.get("doctype"),
            invoice_payload.get("_force_invoice_doctype"),
            data_payload.get("doctype"),
            data_payload.get("_force_invoice_doctype"),
        )
        if _string(value)
    }
    if document_signals and document_signals != {document_type}:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale does not match this POS Profile's invoice type."),
        )
    # Both envelopes participate in normal invoice submission.  Checking only
    # ``invoice`` here allowed a conflicting profile/company value in ``data``
    # to receive a fresh ticket, only for the final submit path to reject it
    # later.  Reject the immutable command before consuming a cashier PIN or
    # minting a replacement bearer.
    for payload in (invoice_payload, data_payload):
        if (
            _string(payload.get("pos_profile")) not in {"", profile_name}
            or _string(payload.get("company")) not in {"", company}
        ):
            _authorization_failure(
                SUPERVISOR_REVIEW_REQUIRED,
                _("The queued offline sale belongs to a different POS Profile or company."),
            )

    # Match the existing outbox submission wrapper: the immutable request ID is
    # authoritative and all aliases are rewritten to it before hashing/signing.
    invoice_payload["posa_client_request_id"] = client_request_id
    data_payload["idempotency_key"] = client_request_id
    data_payload["client_request_id"] = client_request_id
    return invoice_payload, data_payload


def _reauthorization_level(
    prior_claims: dict[str, Any],
    *,
    profile_doc: Any,
    settings: dict[str, Any],
    client_request_id: str,
    document_type: str,
    session_user: str,
) -> str:
    profile_name = _string(_profile_value(profile_doc, "name"))
    company = _string(_profile_value(profile_doc, "company"))
    if (
        prior_claims.get("v") != TICKET_VERSION
        or prior_claims.get("purpose") != TICKET_PURPOSE
        or not _string(prior_claims.get("ticket_id"))
        or _string(prior_claims.get("client_request_id")) != client_request_id
        or _string(prior_claims.get("document_type")) != document_type
        or _string(prior_claims.get("pos_profile")) != profile_name
        or _string(prior_claims.get("company")) != company
    ):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale's original authorization cannot be verified."),
        )

    if (
        _string(prior_claims.get("profile_revision"))
        != _profile_revision(profile_doc)
        or _string(prior_claims.get("session_user")) != session_user
        or _string(prior_claims.get("cash_mode_of_payment"))
        != settings["cash_mode_of_payment"]
        or _as_positive_decimal(prior_claims.get("maximum_amount"))
        > settings["maximum_amount"]
        or _string(prior_claims.get("company_currency"))
        != settings["company_currency"]
    ):
        return SUPERVISOR_REVIEW_REQUIRED
    return REAUTHORIZATION_REQUIRED


def _require_supervisor_reauthorization(
    session_user: str, resolved_cashier: dict[str, Any]
):
    session_can_manage = False
    try:
        from posawesome.posawesome.api.pos_access import user_can_manage_pos

        session_can_manage = bool(user_can_manage_pos(session_user))
    except Exception:
        session_can_manage = False
    if session_can_manage or _as_bool((resolved_cashier or {}).get("is_supervisor")):
        return
    _authorization_failure(
        SUPERVISOR_REVIEW_REQUIRED,
        _("A POS supervisor must review and reauthorize this queued offline sale."),
    )


@frappe.whitelist(methods=["POST"])
def reauthorize_offline_cash_sale_authorization(
    pos_profile=None,
    pin=None,
    client_request_id=None,
    document_type=None,
    invoice=None,
    data=None,
    offline_sale_authorization=None,
):
    """Replace an expired/revoked ticket for one immutable queued command.

    This is intentionally a recovery path, not a new-sale endpoint.  It needs
    the original signed ticket, a fresh PIN, and the exact outbox payload; the
    returned ticket is bound to the same request ID and payload hash.
    """

    redact_cashier_pin_request_context()
    request_id = _string(client_request_id)
    if not request_id:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale is missing its request identity."),
        )
    profile_doc = get_authorized_pos_profile(pos_profile)
    try:
        settings = _offline_cash_sale_settings(profile_doc)
    except getattr(frappe, "PermissionError", PermissionError):
        # A profile may have been disabled, its cash MOP removed, or its
        # company-currency configuration changed since the original ticket.
        # Do not mint a replacement that the final invoice validation can never
        # accept; retain the row for explicit back-office supervisor handling.
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _(
                "The current POS Profile policy no longer permits automatic offline cash-sale reauthorization. A supervisor must verify this sale in the back office."
            ),
            reason=CURRENT_POLICY_REJECTS_COMMAND,
        )
    resolved_document_type = _resolved_document_type(profile_doc)
    requested_document_type = _string(document_type) or resolved_document_type
    if requested_document_type != resolved_document_type:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale does not match this POS Profile's invoice type."),
        )
    invoice_payload, data_payload = _normalize_reauthorization_payload(
        invoice,
        data,
        request_id,
        resolved_document_type,
        profile_doc,
    )
    prior_claims = _decode_claims(offline_sale_authorization)
    session_user = _string(get_authenticated_pos_user())
    if not session_user:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("A valid POS session is required to reauthorize this queued offline sale."),
        )
    approval_level = _reauthorization_level(
        prior_claims,
        profile_doc=profile_doc,
        settings=settings,
        client_request_id=request_id,
        document_type=resolved_document_type,
        session_user=session_user,
    )

    payload_hash = offline_cash_sale_payload_hash(invoice_payload, data_payload)
    prior_payload_hash = _string(prior_claims.get("payload_hash"))
    if prior_payload_hash and not hmac.compare_digest(prior_payload_hash, payload_hash):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale changed after it was previously reauthorized."),
        )

    from posawesome.posawesome.api.employees import resolve_cashier_by_pin

    resolved = resolve_cashier_by_pin(pos_profile=profile_doc, pin=pin)
    cashier = validate_assigned_terminal_cashier(
        _string(_profile_value(profile_doc, "name")),
        _string((resolved or {}).get("user")),
    )
    if _string(prior_claims.get("cashier")) != cashier:
        approval_level = SUPERVISOR_REVIEW_REQUIRED
    if approval_level == SUPERVISOR_REVIEW_REQUIRED:
        _require_supervisor_reauthorization(session_user, resolved or {})
    else:
        prior_expiry = _parse_iso_datetime(prior_claims.get("expires_at"))
        if prior_expiry and prior_expiry > _utcnow():
            _authorization_failure(
                SUPERVISOR_REVIEW_REQUIRED,
                _("The existing offline authorization is still valid and cannot be replaced."),
            )

    claims = _issue_ticket_claims(
        profile_doc=profile_doc,
        cashier=cashier,
        session_user=session_user,
        document_type=resolved_document_type,
        settings=settings,
        client_request_id=request_id,
        payload_hash=payload_hash,
        reauthorized_from_ticket_id=_string(prior_claims.get("ticket_id")),
        reauthorization_level=approval_level,
    )
    # Replacement claims reflect the current POS Profile policy. Check the
    # exact immutable queued command now so a PIN-approved replacement cannot
    # enter a deterministic pause/retry loop at final invoice validation (for
    # example after a lower cap, different cash MOP, or currency policy edit).
    try:
        validate_offline_cash_sale_document(claims, invoice_payload, data_payload)
    except getattr(frappe, "PermissionError", PermissionError) as error:
        # The ticket is being replaced under the *current* profile policy.
        # Do not return a bearer that cannot possibly submit this immutable
        # command; retain it for a supervisor/back-office resolution instead.
        outcome = extract_offline_cash_sale_failure(error)
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            (outcome or {}).get("message")
            or _(
                "The queued offline sale no longer satisfies the current POS Profile policy. A supervisor must verify it in the back office."
            ),
            reason=CURRENT_POLICY_REJECTS_COMMAND,
        )
    return {
        "ticket": _ticket_response(claims),
        "approval_level": approval_level,
    }


def validate_offline_cash_sale_authorization(
    authorization: Any,
    *,
    profile_doc: Any,
    client_request_id: str,
    document_type: str,
    payload_hash: str | None = None,
) -> dict[str, Any]:
    """Validate ticket scope before it freezes a cashier into a new ledger."""

    if document_type not in SUPPORTED_DOCUMENT_TYPES:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization only supports Sales Invoice and POS Invoice."),
        )
    claims = _decode_claims(authorization)
    profile_name = _string(_profile_value(profile_doc, "name"))
    company = _string(_profile_value(profile_doc, "company"))
    profile_revision = _profile_revision(profile_doc)
    try:
        settings = _offline_cash_sale_settings(profile_doc)
    except getattr(frappe, "PermissionError", PermissionError):
        # Initial offline sync can arrive after a ticket was pre-issued but
        # before the POS policy was edited. Treat that as a definitive manual
        # recovery state, not a transient network failure that burns retries.
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _(
                "The current POS Profile policy no longer permits this offline cash sale. A supervisor must verify it in the back office."
            ),
            reason=CURRENT_POLICY_REJECTS_COMMAND,
        )
    if (
        claims.get("v") != TICKET_VERSION
        or claims.get("purpose") != TICKET_PURPOSE
        or not _string(claims.get("ticket_id"))
        or _string(claims.get("client_request_id")) != _string(client_request_id)
        or _string(claims.get("document_type")) != _string(document_type)
        or _string(claims.get("pos_profile")) != profile_name
        or _string(claims.get("company")) != company
        or _string(claims.get("profile_revision")) != profile_revision
        or _string(claims.get("session_user")) != _string(get_authenticated_pos_user())
        or _string(claims.get("cash_mode_of_payment"))
        != settings["cash_mode_of_payment"]
        or _string(claims.get("company_currency"))
        != settings["company_currency"]
    ):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization does not match this POS request."),
        )

    claimed_maximum = _as_positive_decimal(claims.get("maximum_amount"))
    if not claimed_maximum or claimed_maximum > settings["maximum_amount"]:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization exceeds the current POS Profile policy."),
        )
    claimed_payload_hash = _string(claims.get("payload_hash"))
    if claimed_payload_hash and (
        not _string(payload_hash)
        or not hmac.compare_digest(claimed_payload_hash, _string(payload_hash))
    ):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale changed after it was reauthorized."),
        )
    expires_at = _parse_iso_datetime(claims.get("expires_at"))
    if not expires_at or expires_at <= _utcnow():
        _authorization_failure(
            REAUTHORIZATION_REQUIRED,
            _("Offline cash-sale authorization has expired. Reconnect and reauthorize this same queued sale."),
        )
    try:
        cashier = validate_assigned_terminal_cashier(
            profile_name, _string(claims.get("cashier"))
        )
    except Exception:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The cashier who authorized this offline sale is no longer available for this POS Profile."),
        )
    return {**claims, "cashier": cashier, "maximum_amount": claimed_maximum}


def offline_cash_sale_authorization_audit(
    claims: dict[str, Any], *, payload_hash: str | None = None
) -> dict[str, str | int]:
    """Return the non-secret subset that may be kept with a server ledger.

    The browser ticket itself is intentionally never written to a document,
    submission ledger, or diagnostic payload.  A ledger can retain this small
    audit record after it has verified the signature so an interrupted first
    attempt can finish idempotently even after the ticket expires.
    """

    return {
        "v": TICKET_VERSION,
        "purpose": TICKET_PURPOSE,
        "ticket_id": _string(claims.get("ticket_id")),
        "client_request_id": _string(claims.get("client_request_id")),
        "cashier": _string(claims.get("cashier")),
        "session_user": _string(claims.get("session_user")),
        "document_type": _string(claims.get("document_type")),
        "pos_profile": _string(claims.get("pos_profile")),
        "company": _string(claims.get("company")),
        "profile_revision": _string(claims.get("profile_revision")),
        "cash_mode_of_payment": _string(claims.get("cash_mode_of_payment")),
        "maximum_amount": str(_as_positive_decimal(claims.get("maximum_amount"))),
        "company_currency": _string(claims.get("company_currency")),
        # A pre-issued ticket cannot know the future cart.  Once the server
        # accepts the initial command, it records the canonical command hash
        # with the durable ledger so all later retries are immutable too.
        "payload_hash": _string(payload_hash) or _string(claims.get("payload_hash")),
        "issued_at": _string(claims.get("issued_at")),
        "expires_at": _string(claims.get("expires_at")),
        "reauthorized_from_ticket_id": _string(
            claims.get("reauthorized_from_ticket_id")
        ),
        "reauthorization_level": _string(claims.get("reauthorization_level")),
    }


def validate_persisted_offline_cash_sale_audit(
    audit: Any,
    *,
    profile_doc: Any,
    client_request_id: str,
    document_type: str,
    payload_hash: str | None = None,
) -> dict[str, Any]:
    """Recheck a server-created offline authorization audit on a retry.

    This function must only receive an audit recovered from the server-owned
    submission ledger.  Callers must discard similarly named client payload
    values before resolving the ledger.
    """

    if not isinstance(audit, dict):
        _throw(_("Offline cash-sale authorization audit is invalid."))

    profile_name = _string(_profile_value(profile_doc, "name"))
    company = _string(_profile_value(profile_doc, "company"))
    maximum_amount = _as_positive_decimal(audit.get("maximum_amount"))
    session_user = _string(get_authenticated_pos_user())
    original_user = _string(audit.get("session_user"))
    is_supervisor = False
    if session_user and session_user != original_user:
        try:
            from posawesome.posawesome.api.pos_access import user_can_manage_pos

            is_supervisor = bool(user_can_manage_pos(session_user))
        except Exception:
            is_supervisor = False
    if (
        audit.get("v") != TICKET_VERSION
        or audit.get("purpose") != TICKET_PURPOSE
        or not _string(audit.get("ticket_id"))
        or _string(audit.get("client_request_id")) != _string(client_request_id)
        or _string(audit.get("document_type")) != _string(document_type)
        or _string(audit.get("pos_profile")) != profile_name
        or _string(audit.get("company")) != company
        or not original_user
        or (session_user != original_user and not is_supervisor)
        or not _string(audit.get("cashier"))
        or not _string(audit.get("cash_mode_of_payment"))
        or not _string(audit.get("company_currency"))
        or not maximum_amount
    ):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash-sale authorization does not match this POS request."),
        )
    recorded_payload_hash = _string(audit.get("payload_hash"))
    if (
        not recorded_payload_hash
        or not _string(payload_hash)
        or not hmac.compare_digest(recorded_payload_hash, _string(payload_hash))
    ):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("The queued offline sale changed after its server authorization was recorded."),
        )

    # The audit belongs to a server-owned ledger, so expiry, later cashier
    # reassignment, and prospective POS policy edits cannot strand an already
    # accepted exact command.  The original authenticated user may finish it;
    # a POS supervisor may repair it.  Profile/company/document scope and the
    # original financial policy stay immutable in the audit and are checked by
    # validate_offline_cash_sale_document before final submit.
    return {
        **audit,
        "cashier": _string(audit.get("cashier")),
        "maximum_amount": maximum_amount,
    }


def validate_offline_cash_sale_document(
    claims: dict[str, Any], invoice_doc: Any, data: dict[str, Any] | None = None
):
    """Enforce final-form cash-only policy immediately before submission.

    The POS Profile maximum is explicitly expressed in the company currency.
    A recheck is intentionally safe to run more than once: it catches a
    document hook or save-time recalculation that changed the draft after the
    first policy check.
    """

    data = data if isinstance(data, dict) else {}
    if (
        _as_bool(_profile_value(invoice_doc, "is_return"))
        or _string(_profile_value(invoice_doc, "return_against"))
        or not _as_bool(_profile_value(invoice_doc, "is_pos"))
        or _as_bool(data.get("is_credit_sale"))
        or _as_bool(data.get("is_write_off_change"))
        or _is_nonzero_or_invalid_decimal(data.get("write_off_amount"))
        or _is_nonzero_or_invalid_decimal(data.get("redeemed_customer_credit"))
        or _is_nonzero_or_invalid_decimal(data.get("credit_change"))
        or _is_nonzero_or_invalid_decimal(
            _profile_value(invoice_doc, "loyalty_amount")
        )
        or _as_bool(_profile_value(invoice_doc, "redeem_loyalty_points"))
        or any(
            not isinstance(row, dict)
            or _as_decimal(row.get("amount")) is None
            or _as_decimal(row.get("amount")) != 0
            for row in (data.get("gift_card_redemptions") or [])
        )
    ):
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline signed sales support normal POS cash sales only."),
        )

    company_currency = _string(claims.get("company_currency"))
    invoice_company_currency = _string(
        _profile_value(invoice_doc, "company_currency")
    )
    if invoice_company_currency and invoice_company_currency != company_currency:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash sale company currency does not match its authorization."),
        )
    total = _as_positive_decimal(
        _profile_value(invoice_doc, "base_rounded_total")
        or _profile_value(invoice_doc, "base_grand_total")
    )
    if not total and _string(_profile_value(invoice_doc, "currency")) == company_currency:
        total = _as_positive_decimal(
            _profile_value(invoice_doc, "rounded_total")
            or _profile_value(invoice_doc, "grand_total")
        )
    maximum = _as_positive_decimal(claims.get("maximum_amount"))
    if not total or not maximum or total > maximum:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline cash sale exceeds its authorized company-currency maximum amount."),
        )

    cash_mode = _string(claims.get("cash_mode_of_payment"))
    paid_rows: list[tuple[Any, Decimal]] = []
    invoice_currency = _string(_profile_value(invoice_doc, "currency"))
    for row in _profile_value(invoice_doc, "payments", []) or []:
        amount = _as_decimal(_profile_value(row, "amount"))
        base_amount_value = _profile_value(row, "base_amount", None)
        base_amount = (
            _as_decimal(base_amount_value)
            if base_amount_value is not None
            else None
        )
        if (
            amount is None
            or amount < 0
            or (base_amount_value is not None and (base_amount is None or base_amount < 0))
        ):
            _authorization_failure(
                SUPERVISOR_REVIEW_REQUIRED,
                _("Offline signed sales cannot contain negative or invalid payment rows."),
            )
        paid_in_company_currency = (
            base_amount
            if base_amount is not None
            else amount if invoice_currency == company_currency else None
        )
        if paid_in_company_currency is None:
            _authorization_failure(
                SUPERVISOR_REVIEW_REQUIRED,
                _("Offline signed sales in a foreign currency require a valid company-currency payment amount."),
            )
        if amount > 0 or paid_in_company_currency > 0:
            if _string(_profile_value(row, "mode_of_payment")) != cash_mode:
                _authorization_failure(
                    SUPERVISOR_REVIEW_REQUIRED,
                    _("Offline signed sales must use the authorized cash Mode of Payment only."),
                )
            paid_rows.append((row, paid_in_company_currency))
    if not paid_rows:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline signed sales must use the authorized cash Mode of Payment only."),
        )
    paid_total = sum((paid_amount for _row, paid_amount in paid_rows), Decimal("0"))
    if paid_total < total:
        _authorization_failure(
            SUPERVISOR_REVIEW_REQUIRED,
            _("Offline signed sales must be paid in full with cash."),
        )
    return True
