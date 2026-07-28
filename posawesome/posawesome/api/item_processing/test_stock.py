from unittest import TestCase
from unittest.mock import patch

from posawesome.posawesome.api.item_processing import stock


class TestPOSStockAvailability(TestCase):
    def test_leaf_warehouse_subtracts_unconsolidated_pos_reservations(self):
        with (
            patch.object(stock, "_get_stock_warehouses", return_value=["Store - RM"]),
            patch.object(stock, "_get_bin_qty_map", return_value={"ITEM-1": 12}),
            patch.object(
                stock,
                "_get_pos_reserved_qty_map",
                return_value={"ITEM-1": 4},
            ),
        ):
            self.assertEqual(
                stock.get_stock_availability("ITEM-1", "Store - RM"),
                8,
            )

    def test_group_warehouse_uses_all_descendants_for_available_qty(self):
        descendants = ["Store A - RM", "Store B - RM"]
        with (
            patch.object(stock, "_get_stock_warehouses", return_value=descendants),
            patch.object(
                stock,
                "_get_bin_qty_map",
                return_value={"ITEM-1": 20},
            ) as bin_qty,
            patch.object(
                stock,
                "_get_pos_reserved_qty_map",
                return_value={"ITEM-1": 7},
            ) as reserved_qty,
        ):
            self.assertEqual(
                stock.get_stock_availability("ITEM-1", "All Stores - RM"),
                13,
            )
            bin_qty.assert_called_once_with(["ITEM-1"], descendants)
            reserved_qty.assert_called_once_with(["ITEM-1"], descendants)

    def test_bulk_lookup_subtracts_reservations_and_preserves_batch_lookup(self):
        items = [
            {
                "item_code": "ITEM-1",
                "warehouse": "Store - RM",
                "batch_no": "",
            },
            {
                "item_code": "BATCH-1",
                "warehouse": "Store - RM",
                "batch_no": "BATCH-0001",
            },
        ]
        with (
            patch.object(stock.frappe, "get_all", return_value=[]),
            patch.object(stock, "_get_stock_warehouses", return_value=["Store - RM"]),
            patch.object(
                stock,
                "_get_available_qty_map",
                return_value={"ITEM-1": 8},
            ),
            patch.object(stock, "get_batch_qty", return_value=3),
        ):
            result = stock.get_bulk_stock_availability(items)

        self.assertEqual(result[("ITEM-1", "Store - RM", "")], 8)
        self.assertEqual(result[("BATCH-1", "Store - RM", "BATCH-0001")], 3)

    def test_available_qty_uses_one_bulk_lookup_and_keeps_input_order(self):
        items = [
            {"item_code": "ITEM-1", "warehouse": "Store - RM"},
            {
                "item_code": "BATCH-1",
                "warehouse": "Store - RM",
                "batch_no": "BATCH-0001",
            },
        ]
        quantities = {
            ("ITEM-1", "Store - RM", ""): 8,
            ("BATCH-1", "Store - RM", "BATCH-0001"): 3,
        }
        with patch.object(
            stock,
            "get_bulk_stock_availability",
            return_value=quantities,
        ) as bulk:
            result = stock.get_available_qty(items)

        self.assertEqual(
            result,
            [
                {
                    "item_code": "ITEM-1",
                    "warehouse": "Store - RM",
                    "available_qty": 8,
                },
                {
                    "item_code": "BATCH-1",
                    "warehouse": "Store - RM",
                    "available_qty": 3,
                },
            ],
        )
        bulk.assert_called_once()
