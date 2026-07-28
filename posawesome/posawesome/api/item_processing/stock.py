import frappe
from frappe.query_builder import DocType
from frappe.query_builder.functions import IfNull, Sum
from frappe.utils import cstr, flt, json
from erpnext.stock.doctype.batch.batch import get_batch_qty


def _get_stock_warehouses(warehouse, group_warehouses=None):
    if not warehouse:
        return []

    if group_warehouses is None:
        is_group = frappe.db.get_value("Warehouse", warehouse, "is_group")
    else:
        is_group = warehouse in group_warehouses

    if not is_group:
        return [warehouse]

    return frappe.db.get_descendants("Warehouse", warehouse) or []


def _get_bin_qty_map(item_codes, warehouses):
    if not item_codes or not warehouses:
        return {}

    bin_doctype = DocType("Bin")
    rows = (
        frappe.qb.from_(bin_doctype)
        .select(bin_doctype.item_code, Sum(bin_doctype.actual_qty).as_("actual_qty"))
        .where(bin_doctype.item_code.isin(list(item_codes)))
        .where(bin_doctype.warehouse.isin(warehouses))
        .groupby(bin_doctype.item_code)
        .run(as_dict=True)
    )
    return {row.item_code: flt(row.actual_qty) for row in rows}


def _get_pos_reserved_qty_map(item_codes, warehouses):
    """Return stock reserved by submitted, unconsolidated POS Invoices.

    ERPNext POS Invoice mode deliberately posts the Stock Ledger Entry when the
    shift is consolidated. Until then, submitted POS Invoice and Packed Item
    rows reserve stock and must be subtracted from raw Bin quantities everywhere
    the POS displays or validates availability.
    """

    if not item_codes or not warehouses:
        return {}

    pos_invoice = DocType("POS Invoice")
    reserved = {}
    for child_doctype, qty_field in (
        ("POS Invoice Item", "stock_qty"),
        ("Packed Item", "qty"),
    ):
        child = DocType(child_doctype)
        rows = (
            frappe.qb.from_(pos_invoice)
            .from_(child)
            .select(child.item_code, Sum(child[qty_field]).as_("reserved_qty"))
            .where(pos_invoice.name == child.parent)
            .where(IfNull(pos_invoice.consolidated_invoice, "") == "")
            .where(child.docstatus == 1)
            .where(child.item_code.isin(list(item_codes)))
            .where(child.warehouse.isin(warehouses))
            .groupby(child.item_code)
            .run(as_dict=True)
        )
        for row in rows:
            reserved[row.item_code] = reserved.get(row.item_code, 0.0) + flt(row.reserved_qty)

    return reserved


def _get_available_qty_map(item_codes, warehouses):
    bin_qty = _get_bin_qty_map(item_codes, warehouses)
    reserved_qty = _get_pos_reserved_qty_map(item_codes, warehouses)
    return {
        item_code: flt(bin_qty.get(item_code)) - flt(reserved_qty.get(item_code)) for item_code in item_codes
    }


def get_stock_availability(item_code, warehouse):
    """Return POS-aware available quantity for an item and warehouse.

    ``warehouse`` can be either a single warehouse or a warehouse group.
    Submitted, unconsolidated POS Invoice reservations are subtracted from Bin
    quantity, matching ERPNext's native POS Invoice stock contract.
    """

    warehouses = _get_stock_warehouses(warehouse)
    if not warehouses:
        return 0.0

    return _get_available_qty_map([item_code], warehouses).get(item_code, 0.0)


@frappe.whitelist()
def get_bulk_stock_availability(items):
    """
    Fetch available stock for a list of items.

    Args:
        items: List of dicts/objects with 'item_code', 'warehouse', and optional 'batch_no'.

    Returns:
        dict: key=(item_code, warehouse, batch_no), value=qty
    """
    if not items:
        return {}

    # Separate items
    regular_items_map = {}  # (warehouse) -> set(item_code)
    results = {}

    for d in items:
        item_code = d.get("item_code")
        warehouse = d.get("warehouse")
        batch_no = cstr(d.get("batch_no"))  # Normalize to empty string

        if not item_code or not warehouse:
            continue

        if batch_no:
            # Fallback to existing single fetch for batches for now
            results[(item_code, warehouse, batch_no)] = flt(get_batch_qty(batch_no, warehouse))
        else:
            if warehouse not in regular_items_map:
                regular_items_map[warehouse] = set()
            regular_items_map[warehouse].add(item_code)

    if not regular_items_map:
        return results

    # Identify warehouse groups
    all_warehouses = list(regular_items_map.keys())
    group_warehouses = set(
        frappe.get_all("Warehouse", filters={"name": ["in", all_warehouses], "is_group": 1}, pluck="name")
    )

    for warehouse, item_codes in regular_items_map.items():
        if not item_codes:
            continue

        target_warehouses = _get_stock_warehouses(
            warehouse,
            group_warehouses=group_warehouses,
        )

        if not target_warehouses:
            for code in item_codes:
                results[(code, warehouse, "")] = 0.0
            continue

        # Chunking item_codes if too many (SQL IN limit usually 1000s, invoices are smaller)
        item_code_list = list(item_codes)

        qty_map = _get_available_qty_map(item_code_list, target_warehouses)

        for code in item_codes:
            results[(code, warehouse, "")] = qty_map.get(code, 0.0)

    return results


@frappe.whitelist()
def get_available_qty(items):
    """Return available stock quantity for given items.

    Args:
        items (str | list[dict]): JSON string or list of dicts with
            item_code, warehouse and optional batch_no.

    Returns:
        list: List of dicts with item_code, warehouse and available_qty
            in stock UOM.
    """

    if isinstance(items, str):
        items = json.loads(items)

    normalized_items = []
    for it in items or []:
        item_code = it.get("item_code")
        warehouse = it.get("warehouse")
        if not item_code or not warehouse:
            continue
        normalized_items.append(
            {
                "item_code": item_code,
                "warehouse": warehouse,
                "batch_no": cstr(it.get("batch_no")),
            }
        )

    quantities = get_bulk_stock_availability(normalized_items)

    result = []
    for item in normalized_items:
        key = (item["item_code"], item["warehouse"], item["batch_no"])
        result.append(
            {
                "item_code": item["item_code"],
                "warehouse": item["warehouse"],
                "available_qty": flt(quantities.get(key)),
            }
        )

    return result
