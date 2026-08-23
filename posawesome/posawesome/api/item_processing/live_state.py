"""Authoritative, cache-bypassing item state for Hybrid Verified POS search."""

from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from posawesome.posawesome.api.item_fetchers import ItemDetailAggregator
from posawesome.posawesome.api.item_processing.stock import _get_stock_warehouses
from posawesome.posawesome.api.pos_access import (
    get_authorized_pos_item,
    get_authorized_pos_profile,
)
from posawesome.posawesome.stock_version import get_stock_version_snapshot


LIVE_STATE_MAX_ITEMS = 50
LIVE_STATE_SNAPSHOT_RETRIES = 2


def _normalise_item_codes(item_codes):
    if isinstance(item_codes, str):
        try:
            item_codes = json.loads(item_codes)
        except Exception:
            item_codes = [item_codes]

    result = []
    seen = set()
    for raw_code in item_codes or []:
        code = str(raw_code or "").strip()
        if not code or code in seen:
            continue
        seen.add(code)
        result.append(code)

    if len(result) > LIVE_STATE_MAX_ITEMS:
        frappe.throw(
            _("A maximum of {0} items can be verified at once.").format(
                LIVE_STATE_MAX_ITEMS
            )
        )
    return result


def _version_snapshot_for_profile(profile_doc):
    warehouses = _get_stock_warehouses(profile_doc.get("warehouse"))
    return get_stock_version_snapshot(warehouses)


def _latest_modified(doctype, filters):
    rows = frappe.get_all(
        doctype,
        filters=filters,
        fields=["modified"],
        order_by="modified desc",
        limit_page_length=1,
    )
    return str(rows[0].get("modified")) if rows else None


def _build_live_details(profile_doc, item_codes, price_list=None, customer=None):
    item_rows = []
    unavailable = []
    for item_code in item_codes:
        try:
            item_doc = get_authorized_pos_item(item_code, profile_doc)
        except (frappe.PermissionError, frappe.DoesNotExistError):
            unavailable.append(item_code)
            continue

        item_rows.append(
            {
                "item_code": item_doc.name,
                "item_name": item_doc.get("item_name"),
                "description": item_doc.get("description"),
                "stock_uom": item_doc.get("stock_uom"),
                "uom": item_doc.get("stock_uom"),
                "image": item_doc.get("image"),
                "is_stock_item": cint(item_doc.get("is_stock_item")),
                "has_variants": cint(item_doc.get("has_variants")),
                "variant_of": item_doc.get("variant_of"),
                "item_group": item_doc.get("item_group"),
                "has_batch_no": cint(item_doc.get("has_batch_no")),
                "has_serial_no": cint(item_doc.get("has_serial_no")),
                "brand": item_doc.get("brand"),
            }
        )

    live_profile = profile_doc.as_dict()
    live_profile["posa_use_server_cache"] = 0
    live_profile["posa_server_cache_duration"] = 0
    aggregator = ItemDetailAggregator(
        live_profile,
        price_list=price_list or profile_doc.get("selling_price_list"),
        customer=customer,
    )
    return aggregator.build_details(item_rows), unavailable


@frappe.whitelist()
def get_live_item_state(
    pos_profile,
    item_codes,
    price_list=None,
    customer=None,
):
    """Return fresh sellability, stock, price, batch and serial state.

    Candidate search results are allowed to be cached.  This endpoint is not:
    it resolves the POS Profile and Items from the authenticated session,
    bypasses the server detail cache, and brackets the database read with
    realtime version snapshots.  If stock changes during the read, it retries
    so the returned token never overstates consistency.
    """

    codes = _normalise_item_codes(item_codes)
    profile_doc = get_authorized_pos_profile(pos_profile)
    if not codes:
        return {
            "items": [],
            "unavailable_item_codes": [],
            "as_of": str(now_datetime()),
            "stock_versions": _version_snapshot_for_profile(profile_doc),
            "catalog_version": None,
            "price_version": None,
            "verified": True,
        }

    details = []
    unavailable = []
    versions_after = {}
    stable = False
    for _attempt in range(LIVE_STATE_SNAPSHOT_RETRIES):
        versions_before = _version_snapshot_for_profile(profile_doc)
        details, unavailable = _build_live_details(
            profile_doc,
            codes,
            price_list=price_list,
            customer=customer,
        )
        versions_after = _version_snapshot_for_profile(profile_doc)
        if versions_before == versions_after:
            stable = True
            break

    effective_price_list = price_list or profile_doc.get("selling_price_list")
    price_filters = {
        "item_code": ["in", codes],
    }
    if effective_price_list:
        price_filters["price_list"] = effective_price_list

    return {
        "items": details,
        "unavailable_item_codes": unavailable,
        "as_of": str(now_datetime()),
        "stock_versions": versions_after,
        "catalog_version": _latest_modified("Item", {"name": ["in", codes]}),
        "price_version": _latest_modified("Item Price", price_filters),
        "verified": stable,
    }

