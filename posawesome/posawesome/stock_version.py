"""Monotonic stock-version tokens for Hybrid Verified POS search.

MariaDB remains authoritative for stock.  These Redis-backed tokens are only
used to order realtime projections and detect missed events.  A Redis reset
creates a new epoch, which tells clients to discard their previous sequence
and request a fresh snapshot.
"""

from __future__ import annotations

from uuid import uuid4

import frappe


STOCK_VERSION_EPOCH_KEY = "posa:stock-version:epoch"
STOCK_VERSION_SEQUENCE_PREFIX = "posa:stock-version:warehouse"


def _raw_key(key: str):
    return frappe.cache.make_key(key)


def _decode(value):
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value) if value is not None else None


def _ensure_epoch() -> str | None:
    """Return the current Redis epoch, creating it atomically when absent."""

    try:
        key = _raw_key(STOCK_VERSION_EPOCH_KEY)
        frappe.cache.set(key, uuid4().hex, nx=True)
        return _decode(frappe.cache.get(key))
    except Exception:
        frappe.logger().warning("POS stock version cache is unavailable")
        return None


def _sequence_key(warehouse: str):
    return _raw_key(f"{STOCK_VERSION_SEQUENCE_PREFIX}:{warehouse}")


def get_stock_version(warehouse: str) -> dict:
    """Return the current derived version token for one warehouse."""

    warehouse = str(warehouse or "").strip()
    epoch = _ensure_epoch()
    if not warehouse or not epoch:
        return {"epoch": epoch, "version": None}

    try:
        raw_version = frappe.cache.get(_sequence_key(warehouse))
        return {
            "epoch": epoch,
            "version": int(raw_version or 0),
        }
    except Exception:
        frappe.logger().warning("POS stock version sequence is unavailable")
        return {"epoch": epoch, "version": None}


def increment_stock_version(warehouse: str) -> dict:
    """Atomically advance and return a warehouse stock-version token."""

    warehouse = str(warehouse or "").strip()
    epoch = _ensure_epoch()
    if not warehouse or not epoch:
        return {"epoch": epoch, "version": None}

    try:
        version = frappe.cache.incr(_sequence_key(warehouse))
        return {"epoch": epoch, "version": int(version)}
    except Exception:
        frappe.logger().warning("POS stock version increment failed")
        return {"epoch": epoch, "version": None}


def get_stock_version_snapshot(warehouses) -> dict[str, dict]:
    """Return tokens for a deterministic set of warehouse names."""

    return {
        warehouse: get_stock_version(warehouse)
        for warehouse in sorted({str(value).strip() for value in warehouses or [] if value})
    }

