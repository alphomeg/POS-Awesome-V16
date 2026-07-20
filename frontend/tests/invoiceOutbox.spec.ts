// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearOfflineInvoices,
	consumeLastSyncTotals,
	db,
	deleteOfflineInvoice,
	enqueueInvoiceOutboxEntry,
	enqueueWriteQueueEntry,
	finalizeAcknowledgedInvoiceOutboxEntry,
	getInvoiceOutboxMode,
	getInvoiceOutboxRows,
	getLastSyncTotals,
	getOfflineInvoices,
	getPendingInvoiceOutboxCount,
	getPendingInvoiceRecoveryCount,
	getPendingOfflineInvoiceCount,
	initPromise,
	memory,
	migrateInvoiceOutboxModeToCoordinator,
	persistInvoiceIntentJournal,
	recordCoordinatorInvoiceOutboxResult,
	refreshQueueMemory,
	removeInvoiceOutboxEntry,
	resetCoordinatorInvoiceOutboxAccountingForTests,
	saveOfflineCustomer,
	saveOfflineInvoice,
	setInvoiceOutboxMode,
	syncLegacyOfflineInvoices,
	syncInvoiceOutboxResource,
	syncOfflineInvoices,
} from "../src/offline/index";
import { runSupportedOfflineSyncResource } from "../src/offline/sync/resourceRunner";
import {
	getSyncResourceDefinitions,
	getSyncResourcesForTrigger,
} from "../src/offline/sync/resourceRegistry";

function makeInvoiceEntry(
	clientRequestId: string,
	overrides: {
		invoice?: Record<string, any>;
		data?: Record<string, any>;
	} = {},
) {
	return {
		invoice: {
			doctype: "Sales Invoice",
			name: `OFFLINE-${clientRequestId}`,
			customer: "CUST-001",
			pos_profile: "Main POS",
			company: "Test Company",
			posa_client_request_id: clientRequestId,
			items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			...overrides.invoice,
		},
		data: {
			idempotency_key: clientRequestId,
			client_request_id: clientRequestId,
			...overrides.data,
		},
	};
}

function journalStorageKey(clientRequestId: string) {
	return `posa_invoice_intent_${encodeURIComponent(clientRequestId)}`;
}

describe("invoice outbox sync resource", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	beforeEach(async () => {
		await initPromise;
		await db.table("write_queue").clear();
		await db.table("queue").clear();
		await db.table("keyval").clear();
		await db.table("invoice_outbox").clear();
		localStorage.clear();
		memory.offline_invoices = [];
		memory.offline_customers = [];
		memory.pos_last_sync_totals = { pending: 0, synced: 0, drafted: 0 };
		resetCoordinatorInvoiceOutboxAccountingForTests();
		setInvoiceOutboxMode("off");
	});

	it("dual-writes offline invoices and keeps legacy/coordinator counts aligned", async () => {
		setInvoiceOutboxMode("dual_write");

		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-OUTBOX-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-fixed-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-fixed-001" },
		});

		expect(getPendingOfflineInvoiceCount()).toBe(1);
		expect(await getPendingInvoiceOutboxCount()).toBe(1);
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				client_request_id: "outbox-fixed-001",
				status: "pending",
			}),
		]);
	});

	it("copies legacy invoices before activating coordinator mode", async () => {
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-MIGRATION-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-migration-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-migration-001" },
		});

		const migration =
			await migrateInvoiceOutboxModeToCoordinator(getOfflineInvoices());

		expect(migration).toMatchObject({
			mode: "coordinator",
			migrated: 1,
		});
		expect(getInvoiceOutboxMode()).toBe("coordinator");
		expect(getPendingOfflineInvoiceCount()).toBe(1);
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				client_request_id: "outbox-migration-001",
				status: "pending",
			}),
		]);
	});

	it("activates coordinator mode while retaining legacy rows without request IDs", async () => {
		const migration = await migrateInvoiceOutboxModeToCoordinator([
			{
				status: "pending",
				invoice: {
					doctype: "Sales Invoice",
					name: "VERY-OLD-OFFLINE-INVOICE",
				},
				data: {},
			},
		]);

		expect(migration).toEqual({
			mode: "coordinator",
			migrated: 0,
			skipped: 1,
		});
		expect(getInvoiceOutboxMode()).toBe("coordinator");
		expect(await getInvoiceOutboxRows()).toEqual([]);
	});

	it("does not bypass outbox retry ownership through the legacy endpoint", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-OWNERSHIP-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-owned-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-owned-001" },
		});
		const [outboxRow] = await getInvoiceOutboxRows();
		await db.table("invoice_outbox").put({
			...outboxRow,
			status: "retrying",
			retry_count: 1,
			last_error: "temporary outage",
			next_retry_at: new Date(Date.now() + 60_000).toISOString(),
		});
		const legacyCall = vi.fn(async () => ({ message: {} }));
		vi.stubGlobal("frappe", { call: legacyCall });

		await syncLegacyOfflineInvoices();

		expect(legacyCall).not.toHaveBeenCalled();
		expect(getPendingOfflineInvoiceCount()).toBe(0);
		expect(await getPendingInvoiceOutboxCount()).toBe(1);
	});

	it("retains acknowledged audit and syncing compatibility rows during cleanup race", async () => {
		const requestId = "compatibility-sync-race-001";
		const intent = makeInvoiceEntry(requestId);
		const outbox = await enqueueInvoiceOutboxEntry(intent);
		await db.table("invoice_outbox").put({
			...outbox,
			status: "acknowledged",
			invoice_name: "SINV-COMPATIBILITY-RACE-001",
			acknowledged_at: new Date().toISOString(),
		});
		const legacy = await enqueueWriteQueueEntry("invoice", intent);
		await db.table("write_queue").put({
			...legacy,
			status: "syncing",
			last_attempt_at: new Date().toISOString(),
		});
		await refreshQueueMemory("invoice");
		const legacyCall = vi.fn();
		vi.stubGlobal("frappe", { call: legacyCall });

		const totals = await syncLegacyOfflineInvoices();

		expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
		expect(legacyCall).not.toHaveBeenCalled();
		expect(await db.table("write_queue").toArray()).toEqual([
			expect.objectContaining({ status: "syncing" }),
		]);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "SINV-COMPATIBILITY-RACE-001",
			}),
		]);
	});

	it.each([
		[
			"failed",
			{ status: "failed", last_attempt_at: new Date().toISOString() },
		],
		[
			"dead-letter",
			{
				status: "dead_letter",
				last_attempt_at: new Date().toISOString(),
			},
		],
		[
			"stale syncing",
			{
				status: "syncing",
				last_attempt_at: new Date(
					Date.now() - 6 * 60_000,
				).toISOString(),
			},
		],
	])(
		"never replays an outbox-owned %s legacy compatibility row",
		async (_label, queueState) => {
			const requestId = `outbox-owned-${String(queueState.status)}-001`;
			const intent = makeInvoiceEntry(requestId);
			await enqueueInvoiceOutboxEntry(intent);
			const legacy = await enqueueWriteQueueEntry("invoice", intent);
			await db.table("write_queue").put({
				...legacy,
				...queueState,
			});
			await refreshQueueMemory("invoice");
			const legacyCall = vi.fn();
			vi.stubGlobal("frappe", { call: legacyCall });

			const totals = await syncLegacyOfflineInvoices();

			expect(legacyCall).not.toHaveBeenCalled();
			expect(await db.table("write_queue").toArray()).toEqual([]);
			expect(await getInvoiceOutboxRows()).toEqual([
				expect.objectContaining({
					client_request_id: requestId,
					status: "pending",
				}),
			]);
			expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
		},
	);

	it("counts one successful sync for a dual-written request", async () => {
		setInvoiceOutboxMode("coordinator");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-SINGLE-COUNT-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "single-count-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "single-count-001" },
		});
		const submitCall = vi.fn(async ({ method }) => {
			if (method.includes("submit_invoice_outbox_entry")) {
				return {
					message: {
						acknowledged: true,
						client_request_id: "single-count-001",
						invoice: {
							name: "SINV-SINGLE-COUNT-1",
							doctype: "Sales Invoice",
							docstatus: 1,
						},
					},
				};
			}
			throw new Error(`Unexpected legacy call: ${method}`);
		});
		vi.stubGlobal("frappe", { call: submitCall });

		const totals = await syncOfflineInvoices();

		expect(totals).toEqual({ pending: 0, synced: 1, drafted: 0 });
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(getPendingOfflineInvoiceCount()).toBe(0);
	});

	it("continues to submit legacy-only invoices through the compatibility path", async () => {
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-LEGACY-ONLY-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "legacy-only-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "legacy-only-001" },
		});
		const legacyCall = vi.fn(async () => ({
			message: {
				name: "SINV-1",
				doctype: "Sales Invoice",
				docstatus: 1,
				status: 1,
				client_request_id: "legacy-only-001",
			},
		}));
		vi.stubGlobal("frappe", { call: legacyCall });

		await syncLegacyOfflineInvoices();

		expect(legacyCall).toHaveBeenCalledTimes(1);
		expect(legacyCall).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "posawesome.posawesome.api.invoices.submit_invoice",
			}),
		);
		expect(getPendingOfflineInvoiceCount()).toBe(0);
	});

	it("canonicalizes an offline-created customer before outbox acknowledgement", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineCustomer({
			args: {
				customer_name: "TEMP Customer 001",
				customer_type: "Individual",
			},
		});
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-CUSTOMER-RENAME-1",
				customer: "TEMP Customer 001",
				customer_name: "TEMP Customer 001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "customer-rename-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "customer-rename-001" },
		});

		const operationOrder: string[] = [];
		const customerCall = vi.fn(async ({ method }) => {
			expect(method).toBe(
				"posawesome.posawesome.api.customers.create_customer",
			);
			operationOrder.push("customer");
			return { message: { name: "CUST-00042" } };
		});
		vi.stubGlobal("frappe", { call: customerCall });
		const outboxCall = vi.fn(async (_method, args) => {
			operationOrder.push("outbox");
			expect(args?.invoice).toMatchObject({
				customer: "CUST-00042",
				customer_name: "CUST-00042",
			});
			return {
				acknowledged: true,
				client_request_id: "customer-rename-001",
				invoice: {
					name: "SINV-CUSTOMER-RENAME-1",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			};
		});
		const resource = getSyncResourceDefinitions().find(
			(entry) => entry.id === "invoice_outbox",
		);

		await runSupportedOfflineSyncResource({
			resource: resource as any,
			posProfile: { name: "Main POS", company: "Test Company" },
			schemaVersion: "2026-04-09",
			getPersistedState: vi.fn(async () => null),
			callOfflineSyncMethod: outboxCall,
		});
		await syncLegacyOfflineInvoices();

		expect(operationOrder).toEqual(["customer", "outbox"]);
		expect(customerCall).toHaveBeenCalledTimes(1);
		expect(outboxCall).toHaveBeenCalledTimes(1);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "SINV-CUSTOMER-RENAME-1",
				invoice: expect.objectContaining({
					customer: "CUST-00042",
				}),
			}),
		]);
		expect(getPendingOfflineInvoiceCount()).toBe(0);
		expect(getLastSyncTotals()).toEqual({
			pending: 0,
			synced: 1,
			drafted: 0,
		});
	});

	it("single-flights concurrent outbox callers", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-MUTEX-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-mutex-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-mutex-001" },
		});
		let releaseSubmission: ((value: any) => void) | null = null;
		const firstCaller = vi.fn(
			() =>
				new Promise((resolve) => {
					releaseSubmission = resolve;
				}),
		);
		const secondCaller = vi.fn(async () => {
			throw new Error("late competing failure");
		});

		const first = syncInvoiceOutboxResource(firstCaller);
		const second = syncInvoiceOutboxResource(secondCaller);

		expect(second).toBe(first);
		await vi.waitFor(() => expect(firstCaller).toHaveBeenCalledTimes(1));
		releaseSubmission?.({
			acknowledged: true,
			client_request_id: "outbox-mutex-001",
			invoice: {
				name: "SINV-MUTEX-1",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		});
		await first;

		expect(secondCaller).not.toHaveBeenCalled();
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "SINV-MUTEX-1",
			}),
		]);
	});

	it("does not resolve an outbox row from an unacknowledged named response", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-NO-ACK-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-no-ack-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-no-ack-001" },
		});

		const result = await syncInvoiceOutboxResource(async () => ({
			name: "SINV-NO-ACK-1",
			invoice: { name: "SINV-NO-ACK-1", docstatus: 1 },
		}));

		expect(result).toMatchObject({
			status: "error",
			pendingCount: 1,
			acknowledged: 0,
		});
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				client_request_id: "outbox-no-ack-001",
				status: "retrying",
			}),
		]);
	});

	it("keeps dead letters unresolved and reports them as an error", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-DEAD-LETTER-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-dead-letter-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-dead-letter-001" },
		});
		const [row] = await getInvoiceOutboxRows();
		await db.table("invoice_outbox").put({
			...row,
			status: "dead_letter",
			retry_count: 5,
			last_error: "submission exhausted",
			next_retry_at: null,
		});
		const submitCall = vi.fn();

		const result = await syncInvoiceOutboxResource(submitCall);

		expect(submitCall).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "error",
			pendingCount: 1,
			acknowledged: 0,
		});
		expect(result.lastError).toContain("supervisor review");
		expect(await getPendingInvoiceOutboxCount()).toBe(1);
		expect(await getPendingInvoiceRecoveryCount()).toBe(1);
	});

	it("reports a not-yet-due retry as stale instead of fresh", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-WAITING-RETRY-1",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-waiting-retry-001",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-waiting-retry-001" },
		});
		const [row] = await getInvoiceOutboxRows();
		const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
		await db.table("invoice_outbox").put({
			...row,
			status: "retrying",
			retry_count: 1,
			last_error: "temporary outage",
			next_retry_at: nextRetryAt,
			nextAttemptAt: nextRetryAt,
		});
		const submitCall = vi.fn();

		const result = await syncInvoiceOutboxResource(submitCall);

		expect(submitCall).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "stale",
			pendingCount: 1,
			nextRetryAt,
		});
		expect(result.lastError).toContain("waiting for retry");
	});

	it("rejects unsupported or missing document types before journaling or enqueue", async () => {
		const salesOrder = makeInvoiceEntry("unsupported-sales-order-001", {
			invoice: { doctype: "Sales Order" },
		});
		const missingDoctype = makeInvoiceEntry("missing-doctype-001", {
			invoice: { doctype: "" },
		});
		const conflictingDocumentType = makeInvoiceEntry(
			"forced-quotation-001",
			{
				data: { _force_invoice_doctype: "Quotation" },
			},
		);
		const conflictingAllowedTypes = makeInvoiceEntry(
			"sales-pos-conflict-001",
			{
				data: { _force_invoice_doctype: "POS Invoice" },
			},
		);

		expect(() => persistInvoiceIntentJournal(salesOrder)).toThrow(
			"only supports Sales Invoice and POS Invoice",
		);
		expect(() => persistInvoiceIntentJournal(missingDoctype)).toThrow(
			"only supports Sales Invoice and POS Invoice",
		);
		await expect(enqueueInvoiceOutboxEntry(salesOrder)).rejects.toThrow(
			"only supports Sales Invoice and POS Invoice",
		);
		await expect(enqueueInvoiceOutboxEntry(missingDoctype)).rejects.toThrow(
			"only supports Sales Invoice and POS Invoice",
		);
		await expect(
			enqueueInvoiceOutboxEntry(conflictingDocumentType),
		).rejects.toThrow("only supports Sales Invoice and POS Invoice");
		await expect(
			enqueueInvoiceOutboxEntry(conflictingAllowedTypes),
		).rejects.toThrow("exactly one canonical document type");
		expect(
			localStorage.getItem(
				journalStorageKey("unsupported-sales-order-001"),
			),
		).toBeNull();
		expect(
			localStorage.getItem(journalStorageKey("missing-doctype-001")),
		).toBeNull();
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual(
			[],
		);
	});

	it("rejects conflicting client request aliases before offline persistence", async () => {
		const conflictingIdentity = makeInvoiceEntry("request-alias-001", {
			data: { client_request_id: "different-request-alias" },
		});

		expect(() => persistInvoiceIntentJournal(conflictingIdentity)).toThrow(
			"request identity collision",
		);
		await expect(
			enqueueInvoiceOutboxEntry(conflictingIdentity),
		).rejects.toThrow("request identity collision");
		await expect(saveOfflineInvoice(conflictingIdentity)).rejects.toThrow(
			"request identity collision",
		);
		expect(await db.table("write_queue").count()).toBe(0);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual(
			[],
		);
	});

	it("quarantines unsupported legacy invoices without calling invoice APIs", async () => {
		const salesOrder = makeInvoiceEntry("unsupported-legacy-001", {
			invoice: { doctype: "Sales Order" },
		});
		await enqueueWriteQueueEntry("invoice", salesOrder);

		const migration = await migrateInvoiceOutboxModeToCoordinator();
		expect(migration).toEqual({
			mode: "coordinator",
			migrated: 0,
			skipped: 1,
		});
		const legacyCall = vi.fn();
		vi.stubGlobal("frappe", { call: legacyCall });

		const totals = await syncLegacyOfflineInvoices();

		expect(legacyCall).not.toHaveBeenCalled();
		expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
		expect(await db.table("write_queue").toArray()).toEqual([
			expect.objectContaining({
				status: "dead_letter",
				last_error: expect.stringContaining("Sales Order"),
			}),
		]);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual(
			[],
		);
	});

	it("quarantines unsupported outbox rows without replaying them", async () => {
		const entry = makeInvoiceEntry("unsupported-outbox-row-001", {
			invoice: { doctype: "Quotation" },
		});
		const timestamp = new Date().toISOString();
		await db.table("invoice_outbox").add({
			client_request_id: "unsupported-outbox-row-001",
			resource: "invoice_outbox",
			status: "pending",
			invoice: entry.invoice,
			data: entry.data,
			created_at: timestamp,
			updated_at: timestamp,
			next_retry_at: null,
			nextAttemptAt: null,
			retry_count: 0,
			last_error: null,
			invoice_name: null,
			acknowledged_at: null,
		});
		const submitCall = vi.fn();

		const result = await syncInvoiceOutboxResource(submitCall);

		expect(submitCall).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "error",
			pendingCount: 1,
			acknowledged: 0,
		});
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				status: "dead_letter",
				last_error: expect.stringContaining("Quotation"),
			}),
		]);
	});

	it.each([
		[
			"draft status",
			{
				acknowledged: true,
				client_request_id: "invalid-ack-001",
				invoice: {
					name: "SINV-DRAFT-001",
					doctype: "Sales Invoice",
					docstatus: 0,
				},
			},
		],
		[
			"empty document identity",
			{
				acknowledged: true,
				client_request_id: "invalid-ack-001",
				invoice: {
					name: "   ",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			},
		],
		[
			"mismatched request identity",
			{
				acknowledged: true,
				client_request_id: "different-request-id",
				invoice: {
					name: "SINV-MISMATCH-001",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			},
		],
		[
			"contradictory status signals",
			{
				acknowledged: true,
				client_request_id: "invalid-ack-001",
				status: 0,
				invoice: {
					name: "SINV-CONTRADICTORY-001",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			},
		],
		[
			"missing status evidence",
			{
				acknowledged: true,
				client_request_id: "invalid-ack-001",
				invoice: {
					name: "SINV-NO-STATUS-001",
					doctype: "Sales Invoice",
				},
			},
		],
		[
			"cross-type invoice identity",
			{
				acknowledged: true,
				client_request_id: "invalid-ack-001",
				invoice: {
					name: "POSINV-CROSS-TYPE-001",
					doctype: "POS Invoice",
					docstatus: 1,
				},
			},
		],
	])("does not acknowledge a response with %s", async (_label, response) => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice(makeInvoiceEntry("invalid-ack-001"));

		const result = await syncInvoiceOutboxResource(async () => response);

		expect(result).toMatchObject({
			status: "error",
			pendingCount: 1,
			acknowledged: 0,
		});
		expect(result.acknowledgedRequestIds).toEqual([]);
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				client_request_id: "invalid-ack-001",
				status: "retrying",
			}),
		]);
	});

	it("keeps an acknowledged outbox payload immutable on request-ID collision", async () => {
		const original = makeInvoiceEntry("immutable-request-001");
		const created = await enqueueInvoiceOutboxEntry(original);
		const acknowledged = {
			...created,
			status: "acknowledged",
			invoice_name: "SINV-IMMUTABLE-001",
			acknowledged_at: new Date().toISOString(),
		};
		await db.table("invoice_outbox").put(acknowledged);

		await expect(
			enqueueInvoiceOutboxEntry(
				makeInvoiceEntry("immutable-request-001", {
					invoice: { customer: "CUST-DIFFERENT" },
				}),
			),
		).rejects.toThrow("request collision");

		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			acknowledged,
		]);
	});

	it("deletes matching legacy, outbox, and journal records together", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice(makeInvoiceEntry("delete-transaction-001"));
		persistInvoiceIntentJournal(getOfflineInvoices()[0]);

		await expect(deleteOfflineInvoice(0)).resolves.toEqual({
			legacy: 1,
			outbox: 1,
		});
		expect(await db.table("write_queue").toArray()).toEqual([]);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual(
			[],
		);
		expect(getOfflineInvoices()).toEqual([]);
		expect(
			localStorage.getItem(journalStorageKey("delete-transaction-001")),
		).toBeNull();
	});

	it.each(["syncing", "acknowledged"])(
		"refuses to delete a transaction whose outbox is %s",
		async (status) => {
			setInvoiceOutboxMode("dual_write");
			await saveOfflineInvoice(
				makeInvoiceEntry(`protected-${status}-001`),
			);
			persistInvoiceIntentJournal(getOfflineInvoices()[0]);
			const [row] = await getInvoiceOutboxRows({ includeTerminal: true });
			await db.table("invoice_outbox").put({ ...row, status });

			await expect(deleteOfflineInvoice(0)).rejects.toThrow(status);
			expect(await db.table("write_queue").count()).toBe(1);
			expect(
				await getInvoiceOutboxRows({ includeTerminal: true }),
			).toHaveLength(1);
			expect(
				localStorage.getItem(
					journalStorageKey(`protected-${status}-001`),
				),
			).toBeTruthy();
		},
	);

	it("refuses to delete a legacy invoice while its replay claim is active", async () => {
		await saveOfflineInvoice(
			makeInvoiceEntry("protected-legacy-syncing-001"),
		);
		persistInvoiceIntentJournal(getOfflineInvoices()[0]);
		const [row] = await db.table("write_queue").toArray();
		await db.table("write_queue").put({ ...row, status: "syncing" });

		await expect(deleteOfflineInvoice(0)).rejects.toThrow("syncing");
		expect(await db.table("write_queue").count()).toBe(1);
		expect(
			localStorage.getItem(
				journalStorageKey("protected-legacy-syncing-001"),
			),
		).toBeTruthy();
	});

	it("clears every frozen unresolved invoice target and its journal", async () => {
		setInvoiceOutboxMode("dual_write");
		for (const requestId of [
			"clear-transaction-001",
			"clear-transaction-002",
		]) {
			await saveOfflineInvoice(makeInvoiceEntry(requestId));
			persistInvoiceIntentJournal(
				getOfflineInvoices().find(
					(entry) =>
						entry.invoice.posa_client_request_id === requestId,
				),
			);
		}

		await expect(clearOfflineInvoices()).resolves.toEqual({
			legacy: 2,
			outbox: 2,
		});
		expect(await db.table("write_queue").toArray()).toEqual([]);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual(
			[],
		);
		expect(
			localStorage.getItem(journalStorageKey("clear-transaction-001")),
		).toBeNull();
		expect(
			localStorage.getItem(journalStorageKey("clear-transaction-002")),
		).toBeNull();
	});

	it("keeps database rows when journal removal cannot be verified", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice(
			makeInvoiceEntry("journal-delete-failure-001"),
		);
		persistInvoiceIntentJournal(getOfflineInvoices()[0]);
		const originalRemoveItem = Storage.prototype.removeItem;
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
			this: Storage,
			key: string,
		) {
			if (key === journalStorageKey("journal-delete-failure-001")) return;
			originalRemoveItem.call(this, key);
		});

		await expect(deleteOfflineInvoice(0)).rejects.toThrow(
			"could not be removed",
		);
		expect(await db.table("write_queue").count()).toBe(1);
		expect(await getInvoiceOutboxRows()).toHaveLength(1);
		expect(
			localStorage.getItem(
				journalStorageKey("journal-delete-failure-001"),
			),
		).toBeTruthy();
	});

	it.each([
		[
			"draft status",
			{
				name: "SINV-UNSUBMITTED-001",
				doctype: "Sales Invoice",
				docstatus: 0,
				status: 0,
				client_request_id: "legacy-invalid-response-001",
			},
		],
		[
			"stale request identity",
			{
				name: "SINV-STALE-ACK-001",
				doctype: "Sales Invoice",
				docstatus: 1,
				status: 1,
				client_request_id: "different-legacy-request",
			},
		],
		[
			"cross-type identity",
			{
				name: "POSINV-CROSS-TYPE-001",
				doctype: "POS Invoice",
				docstatus: 1,
				status: 1,
				client_request_id: "legacy-invalid-response-001",
			},
		],
		[
			"contradictory statuses",
			{
				name: "SINV-CONTRADICTORY-001",
				doctype: "Sales Invoice",
				docstatus: 1,
				status: 0,
				client_request_id: "legacy-invalid-response-001",
			},
		],
	])(
		"leaves a legacy row unresolved without draft fallback for a returned %s acknowledgement",
		async (_label, response) => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			await saveOfflineInvoice(
				makeInvoiceEntry("legacy-invalid-response-001"),
			);
			const legacyCall = vi.fn(async () => ({ message: response }));
			vi.stubGlobal("frappe", { call: legacyCall });

			const totals = await syncLegacyOfflineInvoices();

			expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
			expect(legacyCall).toHaveBeenCalledTimes(1);
			expect(await db.table("write_queue").toArray()).toEqual([
				expect.objectContaining({ status: "failed", retry_count: 1 }),
			]);
		},
	);

	it("counts a validated legacy draft fallback exactly once", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await saveOfflineInvoice(makeInvoiceEntry("legacy-draft-001"));
		const legacyCall = vi.fn(async ({ method }) => {
			if (method.endsWith("submit_invoice")) {
				throw {
					status: 417,
					responseJSON: {
						exc_type: "ValidationError",
						exception: "Submission was rejected before commit",
					},
				};
			}
			return {
				message: {
					name: "SINV-DRAFT-001",
					doctype: "Sales Invoice",
					docstatus: 0,
					status: 0,
					posa_client_request_id: "legacy-draft-001",
				},
			};
		});
		vi.stubGlobal("frappe", { call: legacyCall });

		const totals = await syncLegacyOfflineInvoices();

		expect(totals).toEqual({ pending: 0, synced: 0, drafted: 1 });
		expect(getPendingOfflineInvoiceCount()).toBe(0);
		expect(await db.table("write_queue").toArray()).toEqual([
			expect.objectContaining({ status: "synced" }),
		]);
	});

	it.each([
		["unknown exception", new Error("submission unavailable")],
		["network failure", { status: 0, statusText: "error" }],
		["timeout", { status: 0, statusText: "timeout" }],
		[
			"request timeout",
			{ status: 408, responseJSON: { exc_type: "TimeoutError" } },
		],
		[
			"conflict",
			{ status: 409, responseJSON: { exc_type: "ConflictError" } },
		],
		[
			"rate limit",
			{ status: 429, responseJSON: { exc_type: "RateLimitError" } },
		],
		[
			"server failure",
			{ status: 500, responseJSON: { exc_type: "ServerError" } },
		],
		[
			"gateway failure",
			{ status: 502, responseJSON: { exc_type: "GatewayError" } },
		],
	])(
		"blocks the legacy draft fallback after an ambiguous %s",
		async (_label, submissionError) => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			await saveOfflineInvoice(makeInvoiceEntry("legacy-ambiguous-001"));
			const legacyCall = vi.fn(async () => {
				throw submissionError;
			});
			vi.stubGlobal("frappe", { call: legacyCall });

			const totals = await syncLegacyOfflineInvoices();

			expect(legacyCall).toHaveBeenCalledTimes(1);
			expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
			expect(await db.table("write_queue").toArray()).toEqual([
				expect.objectContaining({
					status: "failed",
					retry_count: 1,
				}),
			]);
		},
	);

	it("rejects a draft fallback that is not bound to the queued request", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await saveOfflineInvoice(makeInvoiceEntry("legacy-invalid-draft-001"));
		const legacyCall = vi.fn(async ({ method }) => {
			if (method.endsWith("submit_invoice")) {
				throw {
					status: 417,
					responseJSON: {
						exc_type: "ValidationError",
						exception: "Submission was rejected before commit",
					},
				};
			}
			return {
				message: {
					name: "SINV-STALE-DRAFT-001",
					doctype: "Sales Invoice",
					docstatus: 0,
					status: 0,
					posa_client_request_id: "different-draft-request",
				},
			};
		});
		vi.stubGlobal("frappe", { call: legacyCall });

		const totals = await syncLegacyOfflineInvoices();

		expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
		expect(legacyCall).toHaveBeenCalledTimes(2);
		expect(await db.table("write_queue").toArray()).toEqual([
			expect.objectContaining({ status: "failed", retry_count: 1 }),
		]);
	});

	it("does not count a legacy acknowledgement after losing its queue claim", async () => {
		await saveOfflineInvoice(makeInvoiceEntry("legacy-cas-loss-001"));
		const [queued] = await db.table("write_queue").toArray();
		const legacyCall = vi.fn(async ({ method }) => {
			expect(method).toContain("submit_invoice");
			const claimed = await db.table("write_queue").get(queued.queue_id);
			await db.table("write_queue").put({
				...claimed,
				status: "failed",
			});
			return {
				message: {
					name: "SINV-CAS-LOSS-001",
					doctype: "Sales Invoice",
					docstatus: 1,
					status: 1,
					client_request_id: "legacy-cas-loss-001",
				},
			};
		});
		vi.stubGlobal("frappe", { call: legacyCall });

		const totals = await syncLegacyOfflineInvoices();

		expect(totals).toEqual({ pending: 1, synced: 0, drafted: 0 });
		expect(await db.table("write_queue").toArray()).toEqual([
			expect.objectContaining({ status: "failed" }),
		]);
	});

	it("deduplicates coordinator acknowledgements and preserves totals across no-op passes", async () => {
		const result = {
			acknowledgedRequestIds: ["accounting-001", "accounting-001"],
		};
		recordCoordinatorInvoiceOutboxResult(result);
		recordCoordinatorInvoiceOutboxResult(result);

		await expect(syncLegacyOfflineInvoices()).resolves.toEqual({
			pending: 0,
			synced: 1,
			drafted: 0,
		});
		await expect(syncLegacyOfflineInvoices()).resolves.toEqual({
			pending: 0,
			synced: 0,
			drafted: 0,
		});
		expect(getLastSyncTotals()).toEqual({
			pending: 0,
			synced: 1,
			drafted: 0,
		});
		expect(consumeLastSyncTotals()).toEqual({
			pending: 0,
			synced: 1,
			drafted: 0,
		});
		expect(consumeLastSyncTotals()).toEqual({
			pending: 0,
			synced: 0,
			drafted: 0,
		});
	});

	it("retains coordinator acknowledgement accounting when compatibility cleanup fails", async () => {
		const requestId = "accounting-collision-001";
		const original = makeInvoiceEntry(requestId);
		const created = await enqueueInvoiceOutboxEntry(original);
		await db.table("invoice_outbox").put({
			...created,
			status: "acknowledged",
			invoice_name: "SINV-ACCOUNTING-COLLISION-001",
			acknowledged_at: new Date().toISOString(),
		});
		await enqueueWriteQueueEntry(
			"invoice",
			makeInvoiceEntry(requestId, {
				invoice: { customer: "CUST-COLLISION" },
			}),
		);
		recordCoordinatorInvoiceOutboxResult({
			acknowledgedRequestIds: [requestId],
		});

		await expect(syncLegacyOfflineInvoices()).rejects.toThrow(
			"request collision",
		);
		expect(await db.table("write_queue").count()).toBe(1);

		const [legacyRow] = await db.table("write_queue").toArray();
		await db.table("write_queue").put({
			...legacyRow,
			payload: original,
		});
		await refreshQueueMemory("invoice");

		await expect(syncLegacyOfflineInvoices()).resolves.toEqual({
			pending: 0,
			synced: 1,
			drafted: 0,
		});
		await expect(syncLegacyOfflineInvoices()).resolves.toEqual({
			pending: 0,
			synced: 0,
			drafted: 0,
		});
	});

	it("submits an outbox row once across repeated reconnect triggers", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-OUTBOX-2",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-fixed-002",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-fixed-002" },
		});

		const callOfflineSyncMethod = vi.fn(async () => ({
			acknowledged: true,
			client_request_id: "outbox-fixed-002",
			invoice: {
				name: "ACC-SINV-OUTBOX-0001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		}));
		const resource = getSyncResourceDefinitions().find(
			(entry) => entry.id === "invoice_outbox",
		);

		await runSupportedOfflineSyncResource({
			resource: resource as any,
			posProfile: {
				name: "Main POS",
				company: "Test Company",
			},
			schemaVersion: "2026-04-09",
			getPersistedState: vi.fn(async () => null),
			callOfflineSyncMethod,
		});
		await runSupportedOfflineSyncResource({
			resource: resource as any,
			posProfile: {
				name: "Main POS",
				company: "Test Company",
			},
			schemaVersion: "2026-04-09",
			getPersistedState: vi.fn(async () => null),
			callOfflineSyncMethod,
		});

		expect(callOfflineSyncMethod).toHaveBeenCalledTimes(1);
		expect(await getPendingInvoiceOutboxCount()).toBe(0);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "ACC-SINV-OUTBOX-0001",
			}),
		]);
	});

	it("retries a failed reconnect replay without duplicating the final invoice", async () => {
		setInvoiceOutboxMode("dual_write");
		await saveOfflineInvoice({
			invoice: {
				doctype: "Sales Invoice",
				name: "OFFLINE-SINV-OUTBOX-RETRY",
				customer: "CUST-001",
				pos_profile: "Main POS",
				company: "Test Company",
				posa_client_request_id: "outbox-fixed-retry",
				items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1 }],
			},
			data: { idempotency_key: "outbox-fixed-retry" },
		});

		const callOfflineSyncMethod = vi
			.fn()
			.mockRejectedValueOnce(new Error("network offline"))
			.mockResolvedValueOnce({
				acknowledged: true,
				client_request_id: "outbox-fixed-retry",
				invoice: {
					name: "ACC-SINV-OUTBOX-RETRY-0001",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			});
		const resource = getSyncResourceDefinitions().find(
			(entry) => entry.id === "invoice_outbox",
		);
		const runReplay = () =>
			runSupportedOfflineSyncResource({
				resource: resource as any,
				posProfile: {
					name: "Main POS",
					company: "Test Company",
				},
				schemaVersion: "2026-04-09",
				getPersistedState: vi.fn(async () => null),
				callOfflineSyncMethod,
			});

		await runReplay();
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				client_request_id: "outbox-fixed-retry",
				status: "retrying",
			}),
		]);

		const [retryRow] = await getInvoiceOutboxRows();
		await db.table("invoice_outbox").put({
			...retryRow,
			next_retry_at: new Date(Date.now() - 1_000).toISOString(),
			nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
		});
		await runReplay();
		await runReplay();

		expect(callOfflineSyncMethod).toHaveBeenCalledTimes(2);
		expect(await getPendingInvoiceOutboxCount()).toBe(0);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "ACC-SINV-OUTBOX-RETRY-0001",
			}),
		]);
	});

	it("registers invoice_outbox as the transactional reconnect resource", () => {
		expect(
			getSyncResourcesForTrigger("online_resume").map(
				(entry) => entry.id,
			),
		).toContain("invoice_outbox");
		expect(
			getSyncResourceDefinitions().find(
				(entry) => entry.id === "invoice_outbox",
			),
		).toEqual(
			expect.objectContaining({
				priority: "transactional",
				storageKey: "invoice_outbox",
			}),
		);
	});

	it("removes only an exact verified unsent online intent", async () => {
		const intent = makeInvoiceEntry("online-intent-001");
		persistInvoiceIntentJournal(intent);
		await enqueueInvoiceOutboxEntry(intent);

		await expect(
			removeInvoiceOutboxEntry("online-intent-001", intent, "pending"),
		).resolves.toBe(1);
		expect(await getPendingInvoiceOutboxCount()).toBe(0);
		expect(
			localStorage.getItem("posa_invoice_intent_online-intent-001"),
		).toBeNull();
	});

	it.each(["syncing", "acknowledged"])(
		"refuses a stale unsent removal after the outbox advances to %s",
		async (status) => {
			const requestId = `stale-remove-${status}-001`;
			const intent = makeInvoiceEntry(requestId);
			persistInvoiceIntentJournal(intent);
			const created = await enqueueInvoiceOutboxEntry(intent);
			await db.table("invoice_outbox").put({
				...created,
				status,
				sync_attempt_id: status === "syncing" ? "other-lease" : null,
				invoice_name:
					status === "acknowledged" ? "SINV-ALREADY-ACK-001" : null,
			});

			await expect(
				removeInvoiceOutboxEntry(requestId, intent, "pending"),
			).rejects.toThrow(`found ${status}`);
			expect(
				await getInvoiceOutboxRows({ includeTerminal: true }),
			).toHaveLength(1);
			expect(
				localStorage.getItem(journalStorageKey(requestId)),
			).toBeTruthy();
		},
	);

	it("finalizes a direct acknowledgement without deleting its audit row", async () => {
		const requestId = "direct-finalize-001";
		const intent = makeInvoiceEntry(requestId);
		persistInvoiceIntentJournal(intent);
		await enqueueInvoiceOutboxEntry(intent);

		await finalizeAcknowledgedInvoiceOutboxEntry(requestId, intent, {
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-DIRECT-FINALIZE-001",
				doctype: "Sales Invoice",
				docstatus: 1,
				status: 1,
			},
		});

		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				client_request_id: requestId,
				status: "acknowledged",
				invoice_name: "SINV-DIRECT-FINALIZE-001",
			}),
		]);
		expect(localStorage.getItem(journalStorageKey(requestId))).toBeNull();
	});

	it("keeps a direct acknowledgement terminal when a stale coordinator failure completes", async () => {
		const requestId = "direct-ack-race-001";
		const intent = makeInvoiceEntry(requestId);
		persistInvoiceIntentJournal(intent);
		await enqueueInvoiceOutboxEntry(intent);
		let rejectCoordinator: ((error: Error) => void) | null = null;
		const coordinatorCall = vi.fn(
			() =>
				new Promise((_resolve, reject) => {
					rejectCoordinator = reject;
				}),
		);
		const coordinatorSync = syncInvoiceOutboxResource(coordinatorCall);
		await vi.waitFor(async () => {
			expect(
				(await getInvoiceOutboxRows({ includeTerminal: true }))[0]
					?.status,
			).toBe("syncing");
		});

		await finalizeAcknowledgedInvoiceOutboxEntry(requestId, intent, {
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-DIRECT-RACE-001",
				doctype: "Sales Invoice",
				docstatus: 1,
				status: 1,
			},
		});
		rejectCoordinator?.(new Error("stale coordinator failure"));
		const result = await coordinatorSync;

		expect(result).toMatchObject({
			status: "fresh",
			pendingCount: 0,
			acknowledged: 0,
		});
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "SINV-DIRECT-RACE-001",
				last_error: null,
			}),
		]);
	});

	it("surfaces coordinator journal cleanup failure while retaining terminal audit evidence", async () => {
		const requestId = "coordinator-journal-cleanup-001";
		const intent = makeInvoiceEntry(requestId);
		persistInvoiceIntentJournal(intent);
		await enqueueInvoiceOutboxEntry(intent);
		const submitCall = vi.fn(async () => ({
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-COORDINATOR-JOURNAL-001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		}));
		const originalRemoveItem = Storage.prototype.removeItem;
		const removeSpy = vi
			.spyOn(Storage.prototype, "removeItem")
			.mockImplementation(function (this: Storage, key: string) {
				if (key === journalStorageKey(requestId)) return;
				originalRemoveItem.call(this, key);
			});

		await expect(syncInvoiceOutboxResource(submitCall)).rejects.toThrow(
			"could not be removed",
		);
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				client_request_id: requestId,
				status: "acknowledged",
				invoice_name: "SINV-COORDINATOR-JOURNAL-001",
			}),
		]);
		expect(localStorage.getItem(journalStorageKey(requestId))).toBeTruthy();

		removeSpy.mockRestore();
		await expect(
			syncInvoiceOutboxResource(submitCall),
		).resolves.toMatchObject({
			status: "fresh",
			pendingCount: 0,
			acknowledged: 0,
		});
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(journalStorageKey(requestId))).toBeNull();
	});
});
