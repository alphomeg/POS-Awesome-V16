// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import {
	consumeOfflineCashSaleAuthorization,
	db,
	getAvailableOfflineCashSaleAuthorizations,
	initPromise,
	releaseOfflineCashSaleAuthorization,
	reserveOfflineCashSaleAuthorization,
	saveOfflineCashSaleAuthorizations,
} from "../src/offline/index";

const scope = {
	posProfile: "Main POS",
	company: "RetailMind",
	user: "cashier@example.com",
};

const ticket = (requestId: string, cashier = "cashier@example.com") => ({
	authorization: `signed-${requestId}`,
	client_request_id: requestId,
	owner_user: "cashier@example.com",
	expires_at: new Date(Date.now() + 60_000).toISOString(),
	cashier,
	cash_mode_of_payment: "Cash",
	maximum_amount: "1000",
	company_currency: "PKR",
	document_type: "Sales Invoice" as const,
});

describe("offline cash-sale authorizations", () => {
	beforeEach(async () => {
	await initPromise;
	await db.table("keyval").clear();
	await db.table("invoice_outbox").clear();
	localStorage.clear();
	});

	it("keeps server tickets in IndexedDB and reserves one immutable request", async () => {
		await saveOfflineCashSaleAuthorizations(scope, [ticket("offline-1")]);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([
			expect.objectContaining({ client_request_id: "offline-1" }),
		]);
		expect(localStorage.length).toBe(0);

		const reserved = await reserveOfflineCashSaleAuthorization(
			scope,
			"Sales Invoice",
		);
		expect(reserved).toEqual(
			expect.objectContaining({ client_request_id: "offline-1", status: "reserved" }),
		);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([]);

		await expect(
			releaseOfflineCashSaleAuthorization(scope, "offline-1"),
		).resolves.toBe(true);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toHaveLength(1);
	});

	it("reuses a released preferred ticket so a failed pre-durable retry keeps its identity", async () => {
		await saveOfflineCashSaleAuthorizations(scope, [ticket("offline-2")]);
		const first = await reserveOfflineCashSaleAuthorization(
			scope,
			"Sales Invoice",
		);
		await releaseOfflineCashSaleAuthorization(scope, "offline-2");
		const retried = await reserveOfflineCashSaleAuthorization(
			scope,
			"Sales Invoice",
			"offline-2",
		);
		expect(first?.client_request_id).toBe("offline-2");
		expect(retried).toEqual(
			expect.objectContaining({
				client_request_id: "offline-2",
				status: "reserved",
			}),
		);
	});

	it("consumes a ticket only after durable outbox ownership", async () => {
		await saveOfflineCashSaleAuthorizations(scope, [ticket("offline-3")]);
		await reserveOfflineCashSaleAuthorization(scope, "Sales Invoice");
		await expect(
			consumeOfflineCashSaleAuthorization(scope, "offline-3"),
		).resolves.toBe(false);
		await db.table("invoice_outbox").add({
			client_request_id: "offline-3",
			status: "pending",
		});
		await expect(
			consumeOfflineCashSaleAuthorization(scope, "offline-3"),
		).resolves.toBe(true);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([]);
	});

	it("releases abandoned reservations but never releases an outbox-owned ticket", async () => {
		await saveOfflineCashSaleAuthorizations(scope, [ticket("offline-4")]);
		await reserveOfflineCashSaleAuthorization(scope, "Sales Invoice");
		const keyRow = await db.table("keyval").toCollection().first();
		keyRow.value.tickets[0].reserved_at = new Date(
			Date.now() - 11 * 60 * 1_000,
		).toISOString();
		await db.table("keyval").put(keyRow);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([
			expect.objectContaining({ client_request_id: "offline-4" }),
		]);

		await reserveOfflineCashSaleAuthorization(scope, "Sales Invoice");
		await db.table("invoice_outbox").add({
			client_request_id: "offline-4",
			status: "pending",
		});
		await expect(
			releaseOfflineCashSaleAuthorization(scope, "offline-4"),
		).resolves.toBe(false);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([]);
	});

	it("replaces a former cashier batch when a newer cashier prepares tickets", async () => {
		await saveOfflineCashSaleAuthorizations(scope, [
			ticket("offline-a", "a@example.com"),
		]);
		await saveOfflineCashSaleAuthorizations(scope, [
			ticket("offline-b", "b@example.com"),
		]);
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([
			expect.objectContaining({
				client_request_id: "offline-b",
				cashier: "b@example.com",
			}),
		]);
	});

	it("fails closed instead of storing a ticket issued to a different browser user", async () => {
		await expect(
			saveOfflineCashSaleAuthorizations(scope, [
				{ ...ticket("offline-wrong-owner"), owner_user: "other@example.com" },
			]),
		).rejects.toThrow("different signed-in user");
		expect(await getAvailableOfflineCashSaleAuthorizations(scope)).toEqual([]);
	});
});
