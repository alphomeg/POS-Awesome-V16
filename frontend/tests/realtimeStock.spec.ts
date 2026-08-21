import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	dispatchRealtimeStockPayload,
	normalizeRealtimeStockPayload,
	REMOTE_STOCK_ADJUSTMENT_EVENT,
} from "../src/posapp/utils/realtimeStock";
import {
	installStockVersionSnapshot,
	resetStockVersions,
} from "../src/posapp/utils/liveStateVersions";

describe("realtime stock payload dispatch", () => {
	beforeEach(() => {
		resetStockVersions();
		vi.unstubAllGlobals();
	});
	it("normalizes stock updates and deduplicates item codes", () => {
		const payload = normalizeRealtimeStockPayload({
			source_doctype: "Bin",
			items: [
				{ item_code: " ITEM-1 ", warehouse: "Main", actual_qty: "5" },
				{ item_code: "ITEM-1", warehouse: "Main", actual_qty: 5 },
				{ item_code: "ITEM-2", warehouse: "Stores", actual_qty: 2 },
			],
		});

		expect(payload?.item_codes).toEqual(["ITEM-1", "ITEM-2"]);
		expect(payload?.warehouses).toEqual(["Main", "Stores"]);
		expect(payload?.items[0].actual_qty).toBe(5);
	});

	it("updates stock state and emits a remote adjustment event", () => {
		const updateBaseQuantities = vi.fn();
		const emit = vi.fn();
		const setLastStockAdjustment = vi.fn();
		const dispatchEvent = vi.fn();
		vi.stubGlobal("window", { dispatchEvent });

		const payload = dispatchRealtimeStockPayload(
			{
				source_doctype: "Bin",
				items: [
					{ item_code: "ITEM-1", warehouse: "Main", actual_qty: 9 },
					{ item_code: "ITEM-2", warehouse: "Main", actual_qty: "3" },
				],
			},
			{
				updateBaseQuantities,
				emit,
				setLastStockAdjustment,
			},
		);

		expect(updateBaseQuantities).toHaveBeenCalledWith(
			[
				{ item_code: "ITEM-1", warehouse: "Main", actual_qty: 9 },
				{ item_code: "ITEM-2", warehouse: "Main", actual_qty: 3 },
			],
			{ source: "realtime" },
		);
		expect(setLastStockAdjustment).toHaveBeenCalledWith(payload);
		expect(emit).toHaveBeenCalledWith("remote_stock_adjustment", payload);
		expect(dispatchEvent).toHaveBeenCalledTimes(1);
		expect(dispatchEvent.mock.calls[0][0].type).toBe(
			REMOTE_STOCK_ADJUSTMENT_EVENT,
		);
		expect(dispatchEvent.mock.calls[0][0].detail).toBe(payload);
	});

	it("rejects stale events and reports a sequence gap", () => {
		installStockVersionSnapshot({ Main: { epoch: "epoch-a", version: 4 } });
		const updateBaseQuantities = vi.fn();
		const emit = vi.fn();

		const stale = dispatchRealtimeStockPayload(
			{
				items: [
					{
						item_code: "ITEM-1",
						warehouse: "Main",
						actual_qty: 99,
						stock_version: { epoch: "epoch-a", version: 4 },
					},
				],
			},
			{ updateBaseQuantities, emit },
		);
		expect(stale).toBeNull();
		expect(updateBaseQuantities).not.toHaveBeenCalled();

		const gap = dispatchRealtimeStockPayload(
			{
				items: [
					{
						item_code: "ITEM-1",
						warehouse: "Main",
						actual_qty: 2,
						stock_version: { epoch: "epoch-a", version: 7 },
					},
				],
			},
			{ updateBaseQuantities, emit },
		);
		expect(gap?.has_version_gap).toBe(true);
		expect(updateBaseQuantities).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith("stock_version_gap", gap);
	});
});
