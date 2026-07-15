from __future__ import annotations

import json

import frappe


CASHIER_PIN_KEYS = frozenset(
    {
        "cashier_pin",
        "cashierPin",
        "current_pin",
        "new_pin",
        "pin",
        "posa_cashier_pin",
        "_posa_cashier_pin",
        "posa_pos_pin",
    }
)
REDACTED_PIN = "********"


def _redact_value(value):
    if isinstance(value, dict):
        for key in list(value):
            if key in CASHIER_PIN_KEYS:
                value[key] = REDACTED_PIN
            else:
                value[key] = _redact_value(value.get(key))
        return value

    if isinstance(value, list):
        for index, child in enumerate(value):
            value[index] = _redact_value(child)
        return value

    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            parsed = json.loads(value)
        except Exception:
            return value
        return json.dumps(_redact_value(parsed), ensure_ascii=True, separators=(",", ":"))

    return value


def redact_cashier_pin_request_context():
    """Mask PIN values retained by Frappe logging and request recording."""

    containers = []
    try:
        form_dict = getattr(frappe.local, "form_dict", None)
        if isinstance(form_dict, dict):
            containers.append(form_dict)
    except Exception:
        pass

    try:
        recorder_form_dict = getattr(
            getattr(frappe.local, "_recorder", None),
            "form_dict",
            None,
        )
        if isinstance(recorder_form_dict, dict):
            containers.append(recorder_form_dict)
    except Exception:
        pass

    seen = set()
    for container in containers:
        identity = id(container)
        if identity in seen:
            continue
        seen.add(identity)
        _redact_value(container)
