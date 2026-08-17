import unittest
from unittest.mock import patch

from posawesome.posawesome.api.item_processing import live_state


class _Profile(dict):
    __getattr__ = dict.get

    def as_dict(self):
        return dict(self)


class TestLiveItemState(unittest.TestCase):
    def test_normalise_item_codes_is_ordered_bounded_and_deduplicated(self):
        self.assertEqual(
            live_state._normalise_item_codes('[" ITEM-2 ", "ITEM-1", "ITEM-2"]'),
            ["ITEM-2", "ITEM-1"],
        )

    def test_retries_when_stock_version_changes_during_read(self):
        profile = _Profile(
            name="POS-TEST",
            warehouse="Main Warehouse",
            selling_price_list="Retail",
        )
        snapshots = [
            {"Main Warehouse": {"epoch": "a", "version": 1}},
            {"Main Warehouse": {"epoch": "a", "version": 2}},
            {"Main Warehouse": {"epoch": "a", "version": 2}},
            {"Main Warehouse": {"epoch": "a", "version": 2}},
        ]

        with (
            patch.object(live_state, "get_authorized_pos_profile", return_value=profile),
            patch.object(
                live_state,
                "_version_snapshot_for_profile",
                side_effect=snapshots,
            ),
            patch.object(
                live_state,
                "_build_live_details",
                return_value=([{"item_code": "ITEM-1", "actual_qty": 3}], []),
            ) as build_details,
            patch.object(live_state, "_latest_modified", return_value=None),
            patch.object(live_state, "now_datetime", return_value="2026-08-17 12:00:00"),
        ):
            result = live_state.get_live_item_state(
                "POS-TEST",
                ["ITEM-1"],
                price_list="Retail",
            )

        self.assertTrue(result["verified"])
        self.assertEqual(result["stock_versions"]["Main Warehouse"]["version"], 2)
        self.assertEqual(build_details.call_count, 2)

    def test_returns_unverified_when_snapshot_keeps_changing(self):
        profile = _Profile(
            name="POS-TEST",
            warehouse="Main Warehouse",
            selling_price_list="Retail",
        )
        snapshots = [
            {"Main Warehouse": {"epoch": "a", "version": 1}},
            {"Main Warehouse": {"epoch": "a", "version": 2}},
            {"Main Warehouse": {"epoch": "a", "version": 2}},
            {"Main Warehouse": {"epoch": "a", "version": 3}},
        ]

        with (
            patch.object(live_state, "get_authorized_pos_profile", return_value=profile),
            patch.object(
                live_state,
                "_version_snapshot_for_profile",
                side_effect=snapshots,
            ),
            patch.object(
                live_state,
                "_build_live_details",
                return_value=([{"item_code": "ITEM-1", "actual_qty": 3}], []),
            ),
            patch.object(live_state, "_latest_modified", return_value=None),
            patch.object(live_state, "now_datetime", return_value="2026-08-17 12:00:00"),
        ):
            result = live_state.get_live_item_state("POS-TEST", ["ITEM-1"])

        self.assertFalse(result["verified"])
        self.assertEqual(result["stock_versions"]["Main Warehouse"]["version"], 3)
