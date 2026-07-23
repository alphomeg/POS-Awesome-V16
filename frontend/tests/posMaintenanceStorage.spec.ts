// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearDerivedOfflineCaches,
	db,
} from "../src/offline/db";
import {
	getPosStateInventory,
	repairPosAssets,
	resetLocalPosOwnedState,
} from "../src/utils/clearAllCaches";

function installAssetHarness() {
	const origin = window.location.origin;
	const cacheNames = new Set([
		"posawesome-cache-old",
		"posawesome-cache-current",
		"frappe-assets",
	]);
	const posRegistration = {
		scope: `${origin}/`,
		active: {
			scriptURL: `${origin}/sw.js`,
			postMessage: vi.fn(),
		},
		waiting: null,
		installing: null,
		unregister: vi.fn().mockResolvedValue(true),
	};
	const deskRegistration = {
		scope: `${origin}/desk/`,
		active: {
			scriptURL: `${origin}/desk-worker.js`,
			postMessage: vi.fn(),
		},
		waiting: null,
		installing: null,
		unregister: vi.fn().mockResolvedValue(true),
	};

	vi.stubGlobal("caches", {
		keys: vi.fn(async () => Array.from(cacheNames)),
		delete: vi.fn(async (name: string) => cacheNames.delete(name)),
	});
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: {
			getRegistrations: vi.fn(async () => [
				posRegistration,
				deskRegistration,
			]),
		},
	});

	return {
		cacheNames,
		posRegistration,
		deskRegistration,
	};
}

async function seedPosDatabase() {
	if (db.isOpen()) db.close();
	await db.delete();
	await db.open();
	await db.table("invoice_outbox").put({
		client_request_id: "sale-001",
		status: "pending",
		resource: "invoice",
		created_at: new Date().toISOString(),
	});
	await db.table("write_queue").put({
		idempotency_key: "customer-001",
		entity_type: "customer",
		status: "pending",
		resource: "customer",
		created_at: new Date().toISOString(),
	});
	await db.table("queue").put({
		key: "offline_invoices",
		value: [{ client_request_id: "legacy-001" }],
	});
	await db.table("opening_shifts").put({
		name: "POS-OPEN-001",
		user: "cashier@example.com",
		pos_profile: "Main POS",
	});
	await db.table("items").put({
		item_code: "ITEM-001",
		item_name: "Derived item",
		profile_scope: "Main POS",
	});
	await db.table("customers").put({
		name: "CUST-001",
		customer_name: "Protected optimistic customer",
	});
	await db.table("local_stock").put({
		key: "ITEM-001::Main Store",
		value: { actual_qty: 5 },
	});
}

describe("POS-owned browser maintenance", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		localStorage.clear();
		sessionStorage.clear();
		installAssetHarness();
		await seedPosDatabase();
	});

	afterAll(async () => {
		if (db.isOpen()) db.close();
		await db.delete();
	});

	it("clears derived data transactionally while preserving operational stores and overlays", async () => {
		await clearDerivedOfflineCaches();

		expect(await db.table("items").count()).toBe(0);
		expect(await db.table("invoice_outbox").count()).toBe(1);
		expect(await db.table("write_queue").count()).toBe(1);
		expect(await db.table("queue").count()).toBe(1);
		expect(await db.table("opening_shifts").count()).toBe(1);
		expect(await db.table("customers").count()).toBe(1);
		expect(await db.table("local_stock").count()).toBe(1);
	});

	it("repairs only POS-owned caches and service workers", async () => {
		const harness = installAssetHarness();

		const result = await repairPosAssets();

		expect(result.cacheNames).toEqual([
			"posawesome-cache-old",
			"posawesome-cache-current",
		]);
		expect(harness.cacheNames).toEqual(new Set(["frappe-assets"]));
		expect(harness.posRegistration.unregister).toHaveBeenCalledOnce();
		expect(harness.deskRegistration.unregister).not.toHaveBeenCalled();
	});

	it("inventories recovery-sensitive records without exposing payloads", async () => {
		localStorage.setItem("posa_invoice_intent_sale-001", "secret payload");
		localStorage.setItem(
			"posa_active_invoice_submission_recovery_v1",
			"secret recovery",
		);

		const inventory = await getPosStateInventory();

		expect(inventory.operational).toMatchObject({
			invoiceOutbox: 1,
			writeQueue: 1,
			legacyQueue: 1,
			openingShifts: 1,
			intentJournals: 1,
			activeRecoveryPointers: 1,
		});
		expect(JSON.stringify(inventory)).not.toContain("secret payload");
		expect(JSON.stringify(inventory)).not.toContain("secret recovery");
	});

	it("resets only registered POS state and preserves unrelated Frappe storage", async () => {
		localStorage.setItem("posa_invoice_intent_sale-001", "payload");
		localStorage.setItem("frappe-desk-preference", "keep");
		sessionStorage.setItem("posawesome_update_snooze_until", "1");
		sessionStorage.setItem("frappe-route", "keep");

		await resetLocalPosOwnedState();

		expect(localStorage.getItem("posa_invoice_intent_sale-001")).toBeNull();
		expect(localStorage.getItem("frappe-desk-preference")).toBe("keep");
		expect(
			sessionStorage.getItem("posawesome_update_snooze_until"),
		).toBeNull();
		expect(sessionStorage.getItem("frappe-route")).toBe("keep");
	});

	it("does not intercept the browser hard-reload shortcut", () => {
		const event = new KeyboardEvent("keydown", {
			code: "KeyR",
			ctrlKey: true,
			shiftKey: true,
			cancelable: true,
		});

		document.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
	});
});
