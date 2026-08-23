import unittest
import types
from unittest.mock import patch

import frappe

from posawesome.posawesome.api.invoice_processing import stock


class _Row(frappe._dict):
    def as_dict(self):
        return dict(self)


class _Invoice(types.SimpleNamespace):
    def get(self, key, default=None):
        return getattr(self, key, default)


class TestStockSubmissionLocking(unittest.TestCase):
    def test_locks_items_and_bins_in_deterministic_order(self):
        invoice = _Invoice(
            doctype="POS Invoice",
            items=[
                _Row(item_code="ITEM-B", warehouse="Main", qty=1, is_stock_item=1),
                _Row(item_code="ITEM-A", warehouse="Main", qty=1, is_stock_item=1),
            ],
            packed_items=[],
        )
        sql_calls = []

        def fake_sql(query, values=(), as_dict=False, **_kwargs):
            sql_calls.append((" ".join(query.split()), tuple(values), as_dict))
            if "FROM `tabBin`" in query:
                return [{"name": "BIN", "warehouse": "Main"}]
            return []

        with (
            patch.object(
                stock,
                "frappe",
                types.SimpleNamespace(db=types.SimpleNamespace(sql=fake_sql)),
            ),
            patch.object(stock, "_get_stock_warehouses", return_value=["Main"]),
        ):
            locked = stock._lock_stock_rows_for_invoice(invoice)

        self.assertIn("ORDER BY name FOR UPDATE", sql_calls[0][0])
        self.assertEqual(sql_calls[0][1], ("ITEM-A", "ITEM-B"))
        self.assertEqual(sql_calls[1][1], ("ITEM-A", "Main"))
        self.assertEqual(sql_calls[2][1], ("ITEM-B", "Main"))
        self.assertEqual(locked, [("ITEM-A", "Main"), ("ITEM-B", "Main")])

    def test_sales_invoice_without_stock_update_does_not_lock(self):
        invoice = _Invoice(doctype="Sales Invoice", update_stock=0, items=[])
        sql = unittest.mock.Mock()
        with patch.object(
            stock,
            "frappe",
            types.SimpleNamespace(db=types.SimpleNamespace(sql=sql)),
        ):
            self.assertEqual(stock._lock_stock_rows_for_invoice(invoice), [])
        sql.assert_not_called()
