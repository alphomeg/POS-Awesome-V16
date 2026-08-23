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
	getInvoiceOutboxReauthorizationCommand,
	getInvoiceOutboxMode,
	getInvoiceOutboxRows,
	getLastSyncTotals,
	getOfflineInvoices,
	markInvoiceOutboxManualBackofficeReview,
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
	replaceInvoiceOutboxOfflineSaleAuthorization,
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
		owner_user: "test-cashier@example.com",
		pos_profile: "Main POS",
		company: "Test Company",
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

const TEST_OUTBOX_SCOPE = {
	owner_user: "test-cashier@example.com",
	pos_profile: "Main POS",
	company: "Test Company",
};

function syncTestInvoiceOutbox(callOfflineSyncMethod: any) {
	return syncInvoiceOutboxResource(
		callOfflineSyncMethod,
		TEST_OUTBOX_SCOPE,
	);
}

describe("invoice outbox sync resource", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	beforeEach(async () => {
		vi.stubGlobal("frappe", {
			session: { user: TEST_OUTBOX_SCOPE.owner_user },
			boot: {
				pos_profile: {
					name: TEST_OUTBOX_SCOPE.pos_profile,
					company: TEST_OUTBOX_SCOPE.company,
				},
			},
		});
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

	it("captures immutable owner, POS profile, and company routing metadata", async () => {
		const requestId = "outbox-owner-scope-001";
		const ownerScope = {
			owner_user: "cashier-a@example.com",
			pos_profile: "Main POS",
			company: "Test Company",
		};
		const intent = {
			...makeInvoiceEntry(requestId),
			...ownerScope,
		};

		await expect(enqueueInvoiceOutboxEntry(intent)).resolves.toEqual(
			expect.objectContaining({
				owner_scope_version: 1,
				...ownerScope,
			}),
		);
		await expect(
			enqueueInvoiceOutboxEntry({
				...intent,
				owner_user: "cashier-b@example.com",
			}),
		).rejects.toThrow("owner scope collision");
	});

	it.each([
		["cashier", { ...TEST_OUTBOX_SCOPE, owner_user: "cashier-b@example.com" }],
		["POS profile", { ...TEST_OUTBOX_SCOPE, pos_profile: "Other POS" }],
		["company", { ...TEST_OUTBOX_SCOPE, company: "Other Company" }],
	])(
		"does not claim a routed outbox sale under a different %s scope",
		async (_label, activeScope) => {
			const requestId = `outbox-scope-${String(_label).replace(/\s+/g, "-")}-001`;
			await enqueueInvoiceOutboxEntry({
				...makeInvoiceEntry(requestId),
				...TEST_OUTBOX_SCOPE,
			});
			const submitCall = vi.fn();

			const result = await syncInvoiceOutboxResource(
				submitCall,
				activeScope,
			);

			expect(submitCall).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				status: "stale",
				pendingCount: 1,
				nextRetryAt: null,
			});
			expect(result.lastError).toContain("waiting for its owner session");
			expect(await getInvoiceOutboxRows()).toEqual([
				expect.objectContaining({
					status: "waiting_owner",
					retry_count: 0,
					next_retry_at: null,
					nextAttemptAt: null,
				}),
			]);
		},
	);

	it("does not retry a waiting-owner sale and resumes it for its exact owner", async () => {
		const requestId = "outbox-owner-resume-001";
		await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			...TEST_OUTBOX_SCOPE,
		});
		const submitCall = vi.fn(async () => ({
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-OWNER-RESUME-001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		}));

		await syncInvoiceOutboxResource(submitCall, {
			...TEST_OUTBOX_SCOPE,
			owner_user: "cashier-b@example.com",
		});
		await syncInvoiceOutboxResource(submitCall, {
			...TEST_OUTBOX_SCOPE,
			owner_user: "cashier-b@example.com",
		});
		expect(submitCall).not.toHaveBeenCalled();
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({
				status: "waiting_owner",
				retry_count: 0,
			}),
		]);

		await syncTestInvoiceOutbox(submitCall);
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				invoice_name: "SINV-OWNER-RESUME-001",
			}),
		]);
	});

	it("keeps legacy non-ticket outbox rows replayable for compatibility", async () => {
		const requestId = "outbox-legacy-unscoped-001";
		const legacyIntent = makeInvoiceEntry(requestId);
		const timestamp = new Date().toISOString();
		await db.table("invoice_outbox").add({
			client_request_id: requestId,
			resource: "invoice_outbox",
			status: "pending",
			invoice: legacyIntent.invoice,
			data: legacyIntent.data,
			created_at: timestamp,
			updated_at: timestamp,
			next_retry_at: null,
			nextAttemptAt: null,
			retry_count: 0,
			last_error: null,
			invoice_name: null,
			acknowledged_at: null,
		});
		const submitCall = vi.fn(async () => ({
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-LEGACY-UNSCOPED-001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		}));

		await syncInvoiceOutboxResource(submitCall, {
			owner_user: "different-cashier@example.com",
			pos_profile: "Other POS",
			company: "Other Company",
		});

		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({ status: "acknowledged" }),
		]);
	});

	it("fails closed for a bearer-backed row that predates owner metadata", async () => {
		const requestId = "outbox-unscoped-bearer-001";
		const legacyIntent = makeInvoiceEntry(requestId);
		const timestamp = new Date().toISOString();
		await db.table("invoice_outbox").add({
			client_request_id: requestId,
			resource: "invoice_outbox",
			status: "pending",
			invoice: legacyIntent.invoice,
			data: legacyIntent.data,
			offline_sale_authorization: "signed-ticket-secret",
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

		await syncInvoiceOutboxResource(submitCall, {
			...TEST_OUTBOX_SCOPE,
			owner_user: "cashier-a@example.com",
		});

		expect(submitCall).not.toHaveBeenCalled();
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({ status: "waiting_owner" }),
		]);
	});

	it("routes coordinator outbox claims through the active resource-runner scope", async () => {
		const requestId = "outbox-resource-runner-scope-001";
		await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			...TEST_OUTBOX_SCOPE,
			owner_user: "cashier-a@example.com",
		});
		const resource = getSyncResourceDefinitions().find(
			(entry) => entry.id === "invoice_outbox",
		);
		const submitCall = vi.fn(async () => ({
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-RESOURCE-RUNNER-SCOPE-001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		}));
		const run = (sessionUser: string) =>
			runSupportedOfflineSyncResource({
				resource: resource as any,
				posProfile: {
					name: "Main POS",
					company: "Test Company",
				},
				sessionUser,
				schemaVersion: "2026-08-01",
				getPersistedState: vi.fn(async () => null),
				callOfflineSyncMethod: submitCall,
			});

		await run("cashier-b@example.com");
		expect(submitCall).not.toHaveBeenCalled();
		expect(await getInvoiceOutboxRows()).toEqual([
			expect.objectContaining({ status: "waiting_owner" }),
		]);

		await run("cashier-a@example.com");
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({ status: "acknowledged" }),
		]);
	});

	it.each([
		["requires_reauthorization", "requiresReauthorizationCount"],
		["requires_supervisor_review", "requiresSupervisorReviewCount"],
	] as const)(
		"pauses a typed %s result without consuming retry budget or replaying it",
		async (resolution, countField) => {
			const requestId = `outbox-${resolution}-001`;
			await enqueueInvoiceOutboxEntry({
				...makeInvoiceEntry(requestId),
				offline_sale_authorization: "signed-ticket-before-pause",
			});
			const submitCall = vi.fn(async () => ({
				acknowledged: false,
				definitive_rejection: true,
				client_request_id: requestId,
				resolution,
				// The client deliberately does not retain arbitrary server text in
				// its durable recovery row.
				message: "must-not-persist-or-display-server-details",
			}));

			const firstResult = await syncTestInvoiceOutbox(submitCall);
			expect(firstResult).toMatchObject({
				status: "stale",
				pendingCount: 1,
				[countField]: 1,
			});
			expect(await getInvoiceOutboxRows()).toEqual([
				expect.objectContaining({
					status: resolution,
					retry_count: 0,
					next_retry_at: null,
					nextAttemptAt: null,
					last_error: expect.not.stringContaining(
						"must-not-persist-or-display-server-details",
					),
				}),
			]);

			await syncInvoiceOutboxResource(submitCall, {
				...TEST_OUTBOX_SCOPE,
				owner_user: "different-cashier@example.com",
			});
			expect(await getInvoiceOutboxRows()).toEqual([
				expect.objectContaining({ status: resolution }),
			]);
			await syncTestInvoiceOutbox(submitCall);
			expect(submitCall).toHaveBeenCalledTimes(1);
		},
	);

	it("persists a typed current-policy rejection as durable back-office review", async () => {
		const requestId = "outbox-current-policy-review-001";
		await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: "signed-ticket-current-policy",
		});
		const submitCall = vi.fn(async () => ({
			acknowledged: false,
			definitive_rejection: true,
			client_request_id: requestId,
			resolution: "requires_supervisor_review",
			reason: "current_policy_rejects_command",
			message: "must-not-persist-server-policy-diagnostic",
		}));

		await syncTestInvoiceOutbox(submitCall);
		const [stored] = await getInvoiceOutboxRows();
		expect(stored).toMatchObject({
			status: "requires_supervisor_review",
			recovery_action: "manual_backoffice_review",
			last_error: "Offline cash sale requires back-office supervisor review before it can be resolved.",
		});
		expect(stored.last_error).not.toContain("must-not-persist-server-policy-diagnostic");

		const [redacted] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});
		expect(redacted).toMatchObject({
			offline_sale_authorization: null,
			has_offline_sale_authorization: true,
			recovery_action: "manual_backoffice_review",
		});
		expect(JSON.stringify(redacted)).not.toContain(
			"signed-ticket-current-policy",
		);
	});

	it("never persists or displays a ticket bearer echoed by a generic sync error", async () => {
		const requestId = "outbox-bearer-diagnostic-001";
		const bearer = "signed-ticket-must-not-escape-diagnostic";
		await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: bearer,
		});
		const submitCall = vi.fn(async () => {
			throw new Error(
				`network diagnostic echoed args: {"offline_sale_authorization":"${bearer}"}`,
			);
		});

		await syncTestInvoiceOutbox(submitCall);
		const [stored] = await getInvoiceOutboxRows();
		expect(stored).toMatchObject({
			status: "retrying",
			last_error:
				"Offline cash sale could not sync. It remains queued and will retry when the connection is available.",
		});
		expect(stored.last_error).not.toContain(bearer);

		const [redacted] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});
		expect(JSON.stringify(redacted)).not.toContain(bearer);
		expect(redacted.last_error).not.toContain(bearer);
	});

	it("durably records a manual review decision for a paused ticket without mutating its command", async () => {
		const requestId = "outbox-manual-backoffice-mark-001";
		const original = await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: "signed-ticket-manual-mark",
		});
		await db.table("invoice_outbox").put({
			...original,
			status: "requires_reauthorization",
		});
		const [redacted] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});

		const marked = await markInvoiceOutboxManualBackofficeReview(
			requestId,
			redacted,
		);
		expect(marked).toMatchObject({
			status: "requires_supervisor_review",
			recovery_action: "manual_backoffice_review",
		});
		expect(marked.invoice).toEqual(original.invoice);
		expect(marked.data).toEqual(original.data);
	});

	it("replaces only a paused sale bearer before replaying the exact immutable command", async () => {
		const requestId = "outbox-reauthorize-exact-command-001";
		const original = {
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: "signed-ticket-before-reauthorization",
		};
		await enqueueInvoiceOutboxEntry(original);
		const submitCall = vi
			.fn()
			.mockResolvedValueOnce({
				acknowledged: false,
				definitive_rejection: true,
				client_request_id: requestId,
				resolution: "requires_reauthorization",
			})
			.mockResolvedValueOnce({
				acknowledged: true,
				client_request_id: requestId,
				invoice: {
					name: "SINV-REAUTHORIZED-OFFLINE-001",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			});

		await syncTestInvoiceOutbox(submitCall);
		const [paused] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});
		expect(paused).toMatchObject({
			status: "requires_reauthorization",
			offline_sale_authorization: null,
		});

		await expect(
			replaceInvoiceOutboxOfflineSaleAuthorization(
				requestId,
				{
					...paused,
					invoice: { ...paused.invoice, customer: "CUST-TAMPERED" },
				},
				"signed-ticket-before-reauthorization",
				"signed-ticket-after-reauthorization",
				TEST_OUTBOX_SCOPE.owner_user,
			),
		).rejects.toThrow("invoice or data changed");
		await expect(
			replaceInvoiceOutboxOfflineSaleAuthorization(
				requestId,
				{ ...paused, owner_user: "other-cashier@example.com" },
				"signed-ticket-before-reauthorization",
				"signed-ticket-after-reauthorization",
				TEST_OUTBOX_SCOPE.owner_user,
			),
		).rejects.toThrow("owner, POS profile, or company changed");
		await expect(
			replaceInvoiceOutboxOfflineSaleAuthorization(
				requestId,
				{ ...paused, offline_sale_authorization: "stale-signed-ticket" },
				"signed-ticket-before-reauthorization",
				"signed-ticket-after-reauthorization",
				TEST_OUTBOX_SCOPE.owner_user,
			),
		).rejects.toThrow("requires a redacted recovery row");
		const command = await getInvoiceOutboxReauthorizationCommand(
			requestId,
			paused,
		);
		expect(command).toMatchObject({
			client_request_id: requestId,
			document_type: "Sales Invoice",
			offline_sale_authorization:
				"signed-ticket-before-reauthorization",
		});
		await expect(
			replaceInvoiceOutboxOfflineSaleAuthorization(
				requestId,
				paused,
				command.offline_sale_authorization,
				command.offline_sale_authorization,
				TEST_OUTBOX_SCOPE.owner_user,
			),
		).rejects.toThrow("newly issued authorization");

		const replaced = await replaceInvoiceOutboxOfflineSaleAuthorization(
			requestId,
			paused,
			command.offline_sale_authorization,
			"signed-ticket-after-reauthorization",
			TEST_OUTBOX_SCOPE.owner_user,
		);
		expect(replaced).toMatchObject({
			status: "pending",
			offline_sale_authorization: "signed-ticket-after-reauthorization",
			retry_count: 0,
			next_retry_at: null,
			nextAttemptAt: null,
			last_error: null,
			owner_user: original.owner_user,
			pos_profile: original.pos_profile,
			company: original.company,
			recovery_owner_user: TEST_OUTBOX_SCOPE.owner_user,
		});
		expect(replaced.invoice).toEqual(original.invoice);
		expect(replaced.data).toEqual(original.data);

		await syncTestInvoiceOutbox(submitCall);
		expect(submitCall).toHaveBeenCalledTimes(2);
		expect(submitCall).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({
				offline_sale_authorization:
					"signed-ticket-after-reauthorization",
			}),
		);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				offline_sale_authorization: null,
				invoice_name: "SINV-REAUTHORIZED-OFFLINE-001",
			}),
		]);
	});

	it("replays a supervisor-reauthorized row as the fresh ticket owner while preserving original provenance", async () => {
		const requestId = "outbox-supervisor-recovery-owner-001";
		const originalOwner = "cashier-a@example.com";
		const recoveryOwner = "supervisor@example.com";
		const created = await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			owner_user: originalOwner,
			offline_sale_authorization: "expired-cashier-a-ticket",
		});
		await db.table("invoice_outbox").put({
			...created,
			status: "requires_supervisor_review",
			last_error: "Supervisor reauthorization is required.",
		});
		const [paused] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});

		// The backend independently verifies that this session/PIN is a
		// supervisor before it issues the fresh ticket. The client may only use
		// the returned owner while its own authenticated session matches it.
		(globalThis as any).frappe.session.user = recoveryOwner;
		const command = await getInvoiceOutboxReauthorizationCommand(
			requestId,
			paused,
		);
		const replacement = await replaceInvoiceOutboxOfflineSaleAuthorization(
			requestId,
			paused,
			command.offline_sale_authorization,
			"supervisor-replacement-ticket",
			recoveryOwner,
		);
		expect(replacement).toMatchObject({
			owner_user: originalOwner,
			recovery_owner_user: recoveryOwner,
			pos_profile: TEST_OUTBOX_SCOPE.pos_profile,
			company: TEST_OUTBOX_SCOPE.company,
			status: "pending",
		});

		const submitCall = vi.fn(async () => ({
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-SUPERVISOR-RECOVERY-001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		}));
		await syncInvoiceOutboxResource(submitCall, {
			...TEST_OUTBOX_SCOPE,
			owner_user: recoveryOwner,
		});
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				owner_user: originalOwner,
				recovery_owner_user: recoveryOwner,
				status: "acknowledged",
			}),
		]);
	});

	it("redacts paused rows and exposes a bearer only through an exact transient command", async () => {
		const requestId = "outbox-redacted-reauthorization-command-001";
		const created = await enqueueInvoiceOutboxEntry({
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: "stored-ticket-not-for-reactive-ui",
		});
		await db.table("invoice_outbox").put({
			...created,
			status: "requires_reauthorization",
			last_error: "Offline cash-sale authorization must be refreshed.",
		});

		const [redacted] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});
		expect(redacted).toMatchObject({
			client_request_id: requestId,
			status: "requires_reauthorization",
			offline_sale_authorization: null,
		});
		expect(JSON.stringify(redacted)).not.toContain(
			"stored-ticket-not-for-reactive-ui",
		);

		const command = await getInvoiceOutboxReauthorizationCommand(
			requestId,
			redacted,
		);
		expect(command).toMatchObject({
			client_request_id: requestId,
			document_type: "Sales Invoice",
			offline_sale_authorization: "stored-ticket-not-for-reactive-ui",
			invoice: created.invoice,
			data: created.data,
		});
		expect(command.invoice).not.toBe(created.invoice);
		expect(command.data).not.toBe(created.data);

		await expect(
			getInvoiceOutboxReauthorizationCommand(requestId, {
				...redacted,
				data: { ...redacted.data, customer_note: "tampered command" },
			}),
		).rejects.toThrow("invoice or data changed");
		await expect(
			getInvoiceOutboxReauthorizationCommand(requestId, {
				...redacted,
				offline_sale_authorization: "must-never-be-in-reactive-state",
			}),
		).rejects.toThrow("requires a redacted recovery row");

		// A command is only valid for the exact durable bearer it observed. A
		// concurrent recovery flow cannot be overwritten by this stale command.
		await db.table("invoice_outbox").put({
			...created,
			status: "requires_reauthorization",
			offline_sale_authorization: "newer-ticket-after-race",
		});
		await expect(
			replaceInvoiceOutboxOfflineSaleAuthorization(
				requestId,
				redacted,
				command.offline_sale_authorization,
				"fresh-ticket-after-race",
				TEST_OUTBOX_SCOPE.owner_user,
			),
		).rejects.toThrow("authorization changed before replacement");
		const [stillRedacted] = await getInvoiceOutboxRows({
			redactOfflineSaleAuthorization: true,
		});
		expect(JSON.stringify(stillRedacted)).not.toContain(
			"newer-ticket-after-race",
		);
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
		vi.stubGlobal("frappe", {
			session: { user: TEST_OUTBOX_SCOPE.owner_user },
			boot: {
				pos_profile: {
					name: "Main POS",
					company: "Test Company",
				},
			},
			call: submitCall,
		});

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
			sessionUser: TEST_OUTBOX_SCOPE.owner_user,
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

		const first = syncTestInvoiceOutbox(firstCaller);
		const second = syncTestInvoiceOutbox(secondCaller);

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

		const result = await syncTestInvoiceOutbox(async () => ({
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

		const result = await syncTestInvoiceOutbox(submitCall);

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

		const result = await syncTestInvoiceOutbox(submitCall);

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

		const result = await syncTestInvoiceOutbox(submitCall);

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

		const result = await syncTestInvoiceOutbox(async () => response);

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

	it("clears an offline-sale bearer after its exact request is acknowledged", async () => {
		const requestId = "offline-bearer-clear-001";
		const intent = {
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: "signed-ticket-secret",
		};
		await enqueueInvoiceOutboxEntry(intent);

		await finalizeAcknowledgedInvoiceOutboxEntry(requestId, intent, {
			acknowledged: true,
			client_request_id: requestId,
			invoice: {
				name: "SINV-OFFLINE-BEARER-CLEAR-001",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
		});

		expect(await getInvoiceOutboxRows({ includeTerminal: true })).toEqual([
			expect.objectContaining({
				status: "acknowledged",
				offline_sale_authorization: null,
			}),
		]);
	});

	it("keeps a bearer-backed acknowledgement idempotent after redacting the bearer", async () => {
		const requestId = "offline-bearer-idempotent-001";
		const intent = {
			...makeInvoiceEntry(requestId),
			offline_sale_authorization: "signed-ticket-secret",
		};
		const acknowledgement = {
			acknowledged: true as const,
			client_request_id: requestId,
			invoice: {
				name: "SINV-OFFLINE-BEARER-IDEMPOTENT-001",
				doctype: "Sales Invoice" as const,
				docstatus: 1,
			},
		};
		await enqueueInvoiceOutboxEntry(intent);

		await finalizeAcknowledgedInvoiceOutboxEntry(
			requestId,
			intent,
			acknowledgement,
		);
		await expect(
			finalizeAcknowledgedInvoiceOutboxEntry(
				requestId,
				intent,
				acknowledgement,
			),
		).resolves.toMatchObject({
			status: "acknowledged",
			offline_sale_authorization: null,
		});
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
		const coordinatorSync = syncTestInvoiceOutbox(coordinatorCall);
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

		await expect(syncTestInvoiceOutbox(submitCall)).rejects.toThrow(
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
			syncTestInvoiceOutbox(submitCall),
		).resolves.toMatchObject({
			status: "fresh",
			pendingCount: 0,
			acknowledged: 0,
		});
		expect(submitCall).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(journalStorageKey(requestId))).toBeNull();
	});
});
