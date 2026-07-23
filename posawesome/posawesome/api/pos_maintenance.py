from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.utils import cint, get_datetime, now_datetime, time_diff_in_seconds

from posawesome.posawesome.api.pos_access import (
    get_authenticated_pos_user,
    get_authorized_pos_profile,
    user_can_manage_pos,
)


SUBMISSION_LEDGER_DOCTYPE = "POS Invoice Submission Ledger"
ACTIVE_SUBMISSION_STATES = ("RECEIVED", "DRAFT_CREATED", "SUBMITTED")
SUBMISSION_JOB_METHODS = {
    "posawesome.posawesome.api.invoice_processing.creation.submit_in_background_job",
    "posawesome.posawesome.api.invoice_processing.creation.submit_payload_in_background_job",
}


def _has_system_manager_role():
    return "System Manager" in set(frappe.get_roles())


def _queue_health():
    result = {
        "default_worker_available": False,
        "workers": {"default": 0, "short": 0, "long": 0},
        "queue_depth": {"default": 0, "short": 0, "long": 0},
        "submission_jobs": 0,
        "error": None,
    }
    try:
        from frappe.utils.background_jobs import get_queue, get_workers

        for queue_name in ("default", "short", "long"):
            queue = get_queue(queue_name)
            result["workers"][queue_name] = len(get_workers(queue))
            result["queue_depth"][queue_name] = cint(queue.count)
            if queue_name == "default":
                result["default_worker_available"] = bool(
                    result["workers"][queue_name]
                )
                for job in queue.jobs:
                    kwargs = getattr(job, "kwargs", {}) or {}
                    if kwargs.get("site") != frappe.local.site:
                        continue
                    if kwargs.get("method") in SUBMISSION_JOB_METHODS:
                        result["submission_jobs"] += 1
    except Exception as error:
        result["error"] = _("Queue health is unavailable: {0}").format(str(error))
    return result


def _ledger_age_seconds(modified):
    if not modified:
        return None
    try:
        return max(
            0,
            cint(
                time_diff_in_seconds(
                    now_datetime(),
                    get_datetime(modified),
                )
            ),
        )
    except Exception:
        return None


def collect_pos_operational_health(
    pos_profile=None,
    include_request_details=False,
    company=None,
):
    if pos_profile and not company:
        company = frappe.db.get_value("POS Profile", pos_profile, "company")

    filters = {"state": ["in", ACTIVE_SUBMISSION_STATES]}
    if pos_profile:
        filters["pos_profile"] = pos_profile
    if company:
        filters["company"] = company

    ledgers = frappe.get_all(
        SUBMISSION_LEDGER_DOCTYPE,
        filters=filters,
        fields=[
            "name",
            "client_request_id",
            "state",
            "document_type",
            "invoice_name",
            "modified",
        ],
        order_by="modified asc",
        limit_page_length=100,
    )
    ledger_summaries = []
    for ledger in ledgers:
        summary = {
            "state": ledger.get("state"),
            "document_type": ledger.get("document_type"),
            "has_invoice": bool(ledger.get("invoice_name")),
            "age_seconds": _ledger_age_seconds(ledger.get("modified")),
        }
        if include_request_details:
            summary.update(
                {
                    "ledger_name": ledger.get("name"),
                    "client_request_id": ledger.get("client_request_id"),
                    "invoice_name": ledger.get("invoice_name"),
                }
            )
        ledger_summaries.append(summary)

    profile_background_enabled = False
    if pos_profile:
        profile_background_enabled = bool(
            cint(
                frappe.db.get_value(
                    "POS Profile",
                    pos_profile,
                    "posa_allow_submissions_in_background_job",
                )
            )
        )

    queue = _queue_health()
    return {
        "site": frappe.local.site,
        "checked_at": now_datetime(),
        "pos_profile": pos_profile,
        "company": company,
        "background_submission_enabled": profile_background_enabled,
        "submission_mode": (
            "background"
            if profile_background_enabled and queue["default_worker_available"]
            else "synchronous_fallback"
            if profile_background_enabled
            else "synchronous"
        ),
        "queue": queue,
        "active_submission_count": len(ledgers),
        "oldest_active_age_seconds": max(
            [
                item["age_seconds"]
                for item in ledger_summaries
                if item["age_seconds"] is not None
            ]
            or [0]
        ),
        "active_submissions": ledger_summaries,
        "developer_reset_enabled": bool(
            cint(frappe.conf.get("posa_enable_developer_reset"))
        ),
    }


@frappe.whitelist()
def get_pos_operational_health(pos_profile=None):
    profile_doc = get_authorized_pos_profile(pos_profile)
    profile_name = str(profile_doc.get("name") or "").strip()
    health = collect_pos_operational_health(
        profile_name,
        include_request_details=user_can_manage_pos(
            get_authenticated_pos_user()
        ),
        company=profile_doc.get("company"),
    )
    health["developer_reset_allowed"] = bool(
        health["developer_reset_enabled"] and _has_system_manager_role()
    )
    return health


def _validate_client_inventory(inventory):
    if isinstance(inventory, str):
        try:
            inventory = json.loads(inventory)
        except Exception:
            inventory = {}
    inventory = inventory if isinstance(inventory, dict) else {}
    operational = inventory.get("operational")
    operational = operational if isinstance(operational, dict) else {}
    return {
        "local_storage_keys": cint(inventory.get("localStorageKeys")),
        "session_storage_keys": cint(inventory.get("sessionStorageKeys")),
        "cache_names": len(inventory.get("cacheNames") or []),
        "invoice_outbox": cint(operational.get("invoiceOutbox")),
        "write_queue": cint(operational.get("writeQueue")),
        "legacy_queue": cint(operational.get("legacyQueue")),
        "intent_journals": cint(operational.get("intentJournals")),
        "active_recovery_pointers": cint(
            operational.get("activeRecoveryPointers")
        ),
    }


@frappe.whitelist()
def record_developer_reset(pos_profile, phase, inventory=None):
    if not cint(frappe.conf.get("posa_enable_developer_reset")):
        frappe.throw(_("Local POS reset is not enabled for this site"))
    if not _has_system_manager_role():
        frappe.throw(
            _("Only a System Manager can reset local POS state"),
            getattr(frappe, "PermissionError", PermissionError),
        )

    profile_doc = get_authorized_pos_profile(pos_profile)
    phase = str(phase or "").strip().lower()
    if phase not in {"started", "completed", "failed"}:
        frappe.throw(_("Unsupported reset audit phase"))

    client_counts = _validate_client_inventory(inventory)
    subject = _("POS local reset {0}").format(phase)
    content = json.dumps(
        {
            "event": "pos_local_reset",
            "phase": phase,
            "actor": frappe.session.user,
            "site": frappe.local.site,
            "pos_profile": profile_doc.get("name"),
            "company": profile_doc.get("company"),
            "client_reported_counts": client_counts,
        },
        sort_keys=True,
        default=str,
    )
    comment = frappe.get_doc(
        {
            "doctype": "Comment",
            "comment_type": "Info",
            "reference_doctype": "POS Profile",
            "reference_name": profile_doc.get("name"),
            "subject": subject,
            "content": content,
        }
    )
    comment.insert(ignore_permissions=True)
    return {
        "allowed": True,
        "phase": phase,
        "audit": comment.name,
    }
