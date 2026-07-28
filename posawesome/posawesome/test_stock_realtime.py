from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from posawesome.posawesome import stock_realtime


class _AfterCommit:
    def __init__(self):
        self.callbacks = []

    def add(self, callback):
        self.callbacks.append(callback)


class _Row(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class TestStockRealtime(TestCase):
    def setUp(self):
        self.flags = SimpleNamespace()
        self.after_commit = _AfterCommit()
        self.db = SimpleNamespace(after_commit=self.after_commit)
        self.frappe_patches = (
            patch.object(stock_realtime.frappe, "flags", self.flags),
            patch.object(stock_realtime.frappe, "db", self.db),
            patch.object(
                stock_realtime.frappe,
                "get_cached_value",
                return_value="Test Company",
            ),
        )
        for frappe_patch in self.frappe_patches:
            frappe_patch.start()

    def tearDown(self):
        for frappe_patch in reversed(self.frappe_patches):
            frappe_patch.stop()

    def test_pos_invoice_queues_each_unique_item_warehouse_after_commit(self):
        doc = _Row(
            items=[
                _Row(item_code="ITEM-1", warehouse="Store - RM"),
                _Row(item_code="ITEM-1", warehouse="Store - RM"),
                _Row(item_code="ITEM-2", warehouse="Store - RM"),
            ],
            packed_items=[],
        )

        stock_realtime.publish_pos_invoice_stock_change(doc)

        queue = self.flags._posa_stock_change_queue
        self.assertEqual(
            sorted(queue),
            [
                ("ITEM-1", "Store - RM"),
                ("ITEM-2", "Store - RM"),
            ],
        )
        self.assertEqual(len(self.after_commit.callbacks), 1)

    def test_flush_publishes_reservation_aware_quantities(self):
        self.flags._posa_stock_change_queue = {
            ("ITEM-1", "Store - RM"): {
                "item_code": "ITEM-1",
                "warehouse": "Store - RM",
                "company": "Test Company",
                "actual_qty": 12,
                "source_doctype": "POS Invoice",
            }
        }
        self.flags._posa_stock_change_flush_registered = True

        with (
            patch(
                "posawesome.posawesome.api.item_processing.stock.get_stock_availability",
                return_value=8,
            ),
            patch.object(stock_realtime.frappe, "publish_realtime") as publish,
        ):
            stock_realtime._flush_stock_change_queue()

        payload = publish.call_args.args[1]
        self.assertEqual(payload["items"][0]["actual_qty"], 8)
        self.assertEqual(payload["source_doctype"], "POS Invoice")
