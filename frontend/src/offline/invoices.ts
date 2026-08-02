import { db, isOffline, memory, persist } from "./db";
import { syncOfflineCustomers } from "./customers";
import { reduceCacheUsage } from "./cache";
import { ensureOfflineInvoiceRequest } from "./idempotency";
import {
	enqueueInvoiceOutboxEntry,
	attachInvoiceOutboxOwnerScope,
	assertConsistentInvoiceRequestIdentity,
	assertSupportedInvoiceOutboxEntry,
	getInvoiceClientRequestId,
	getInvoiceOutboxMode,
	getInvoiceOutboxRows,
	haveMatchingInvoiceOutboxIntent,
	removeInvoiceIntentJournalStrict,
	resolveInvoiceOutboxOwnerScope,
	syncInvoiceOutboxResource,
	shouldWriteInvoiceOutbox,
	type InvoiceOutboxEntry,
} from "./invoiceOutbox";
import { updateLocalStock } from "./stock";
import {
	claimRetryableQueueEntries,
	enqueueWriteQueueEntry,
	getQueuedPayloadCount,
	getQueuedPayloadSnapshots,
	getQueueEntries,
	isStaleWriteQueueSyncLease,
	markWriteQueueEntryDeadLetter,
	markWriteQueueEntryFailed,
	markWriteQueueEntrySynced,
	refreshQueueMemory,
	type OfflineEntityType,
	type OfflineQueueEntry,
} from "./writeQueue";

type AnyRecord = Record<string, any>;

const INVOICE_ENTITY: OfflineEntityType = "invoice";

const asBoolean = (value: any): boolean => {
	return (
		value === true ||
		value === 1 ||
		value === "1" ||
		value === "true" ||
		value === "Yes" ||
		value === "yes"
	);
};

type InvoiceSyncTotals = {
	pending: number;
	synced: number;
	drafted: number;
};

let legacyInvoiceSyncPromise: Promise<InvoiceSyncTotals> | null = null;
let invoiceRecoveryPromise: Promise<InvoiceSyncTotals> | null = null;
const pendingCoordinatorAcknowledgementIds = new Set<string>();

export function recordCoordinatorInvoiceOutboxResult(result: AnyRecord = {}) {
	const requestIds = Array.isArray(result?.acknowledgedRequestIds)
		? result.acknowledgedRequestIds
		: [];
	requestIds.forEach((requestId: unknown) => {
		const normalizedId = String(requestId || "").trim();
		if (normalizedId) {
			pendingCoordinatorAcknowledgementIds.add(normalizedId);
		}
	});
}

function snapshotCoordinatorOutboxAcknowledgements() {
	return Array.from(pendingCoordinatorAcknowledgementIds);
}

function commitCoordinatorOutboxAcknowledgements(requestIds: string[]) {
	requestIds.forEach((requestId) =>
		pendingCoordinatorAcknowledgementIds.delete(requestId),
	);
}

export function resetCoordinatorInvoiceOutboxAccountingForTests() {
	pendingCoordinatorAcknowledgementIds.clear();
}

function shouldValidateOfflineInvoiceStock(invoice: AnyRecord) {
	if (!invoice || invoice.is_return) {
		return false;
	}

	const doctype = String(invoice.doctype || "").trim();
	if (["Sales Order", "Quotation", "Purchase Order"].includes(doctype)) {
		return false;
	}

	if (doctype === "Sales Invoice") {
		return asBoolean(invoice.update_stock);
	}

	if (doctype === "POS Invoice") {
		return true;
	}

	return true;
}

export function validateStockForOfflineInvoice(
	items: AnyRecord[],
	invoice: AnyRecord = {},
) {
	const openingStorage = memory.pos_opening_storage || {};
	const stockSettings = openingStorage?.stock_settings || {};
	const posProfile = openingStorage?.pos_profile || {};

	if (!shouldValidateOfflineInvoiceStock(invoice)) {
		return { isValid: true, invalidItems: [], errorMessage: "" };
	}

	const allowOfflineWithoutStockVerification = asBoolean(
		posProfile?.posa_allow_offline_sale_without_stock_verification,
	);
	if (allowOfflineWithoutStockVerification) {
		return { isValid: true, invalidItems: [], errorMessage: "" };
	}

	const blockSaleBeyondAvailableQty = asBoolean(
		posProfile?.posa_block_sale_beyond_available_qty,
	);
	const allowGlobalNegativeStock = asBoolean(
		stockSettings?.allow_negative_stock,
	);

	const stockCache = memory.local_stock_cache || {};
	const invalidItems: AnyRecord[] = [];
	const requestedByItem = new Map<string, AnyRecord>();

	items.forEach((item) => {
		if (!asBoolean(item?.is_stock_item)) {
			return;
		}

		const itemCode = item.item_code;
		if (!itemCode || Number(item.qty || 0) < 0) {
			return;
		}

		const itemAllowsNegativeStock = asBoolean(item?.allow_negative_stock);
		if (
			!blockSaleBeyondAvailableQty &&
			(allowGlobalNegativeStock || itemAllowsNegativeStock)
		) {
			return;
		}

		const requestedQty = Math.abs(
			Number(item.stock_qty ?? item.qty ?? 0) || 0,
		);
		const existing = requestedByItem.get(itemCode);
		if (existing) {
			existing.requested_qty += requestedQty;
			return;
		}

		requestedByItem.set(itemCode, {
			item_code: itemCode,
			item_name: item.item_name || itemCode,
			requested_qty: requestedQty,
		});
	});

	requestedByItem.forEach((item) => {
		const currentStock = Number(
			stockCache[item.item_code]?.actual_qty || 0,
		);

		if (currentStock - item.requested_qty < 0) {
			invalidItems.push({
				item_code: item.item_code,
				item_name: item.item_name,
				requested_qty: item.requested_qty,
				available_qty: currentStock,
			});
		}
	});

	let errorMessage = "";
	if (invalidItems.length === 1) {
		const item = invalidItems[0];
		if (item) {
			errorMessage = `Not enough stock for ${item.item_name}. You need ${item.requested_qty} but only ${item.available_qty} available.`;
		}
	} else if (invalidItems.length > 1) {
		errorMessage =
			"Insufficient stock for multiple items:\n" +
			invalidItems
				.map(
					(item) =>
						`â€¢ ${item.item_name}: Need ${item.requested_qty}, Have ${item.available_qty}`,
				)
				.join("\n");
	}

	return {
		isValid: invalidItems.length === 0,
		invalidItems,
		errorMessage,
	};
}

function prepareOfflineInvoiceEntry(entry: AnyRecord) {
	assertSupportedInvoiceOutboxEntry(entry, "Offline transaction recovery");
	assertConsistentInvoiceRequestIdentity(
		entry,
		"Offline transaction recovery",
	);
	ensureOfflineInvoiceRequest(entry);

	if (
		!entry.invoice ||
		!Array.isArray(entry.invoice.items) ||
		!entry.invoice.items.length
	) {
		throw new Error("Cart is empty. Add items before saving.");
	}

	const validation = validateStockForOfflineInvoice(
		entry.invoice.items,
		entry.invoice,
	);
	if (!validation.isValid) {
		throw new Error(validation.errorMessage);
	}

	let cleanEntry;
	try {
		cleanEntry = JSON.parse(JSON.stringify(entry));
	} catch (error) {
		console.error("Failed to serialize offline invoice", error);
		throw error;
	}

	const replaySources = Array.isArray(cleanEntry?.data?.customer_credit_dict)
		? cleanEntry.data.customer_credit_dict.filter(
				(row: AnyRecord) => Number(row?.credit_to_redeem || 0) > 0,
			)
		: [];

	if (
		Number(cleanEntry?.data?.redeemed_customer_credit || 0) > 0 &&
		cleanEntry?.invoice?.customer &&
		replaySources.length
	) {
		cleanEntry.data.customer_balance_replay = {
			customer: cleanEntry.invoice.customer,
			redeemed_customer_credit: cleanEntry.data.redeemed_customer_credit,
			sources: replaySources,
			timestamp: Date.now(),
		};
	}

	return cleanEntry;
}

export async function saveOfflineInvoice(entry: AnyRecord) {
	const cleanEntry = attachInvoiceOutboxOwnerScope(
		prepareOfflineInvoiceEntry(entry),
	);
	if (shouldWriteInvoiceOutbox()) {
		await enqueueInvoiceOutboxEntry(cleanEntry);
	}
	const createdEntry = await enqueueWriteQueueEntry(
		INVOICE_ENTITY,
		cleanEntry,
	);

	if (
		entry.invoice?.items &&
		shouldValidateOfflineInvoiceStock(entry.invoice)
	) {
		updateLocalStock(entry.invoice.items);
	}

	return createdEntry;
}

export function getOfflineInvoices() {
	return getQueuedPayloadSnapshots(INVOICE_ENTITY);
}

function assertOutboxRowsCanBeRemoved(rows: InvoiceOutboxEntry[]) {
	const protectedRow = rows.find((row) => row.status !== "pending");
	if (protectedRow) {
		throw new Error(
			`Invoice ${protectedRow.client_request_id} cannot be deleted while its recovery status is ${protectedRow.status}`,
		);
	}
}

function assertLegacyRowsCanBeRemoved(rows: OfflineQueueEntry[]) {
	const protectedRow = rows.find((row) => row.status !== "pending");
	if (protectedRow) {
		throw new Error(
			`Invoice queue entry ${protectedRow.queue_id} cannot be deleted while its recovery status is ${protectedRow.status}`,
		);
	}
}

async function removeOfflineInvoiceTransactions(options: {
	legacyEntries: OfflineQueueEntry[];
	includeAllUnresolvedOutbox?: boolean;
}) {
	const legacyEntries = options.legacyEntries.filter(
		(entry) => !!entry?.queue_id,
	);
	assertLegacyRowsCanBeRemoved(legacyEntries);
	const legacyQueueIds = legacyEntries.map((entry) => Number(entry.queue_id));
	const requestIds = new Set(
		legacyEntries
			.map((entry) => getInvoiceClientRequestId(entry))
			.filter(Boolean),
	);
	const writeQueueTable = db.table("write_queue");
	const outboxTable = db.table("invoice_outbox");
	const allOutboxRows = (await outboxTable.toArray()) as InvoiceOutboxEntry[];
	const selectOutboxRows = (rows: InvoiceOutboxEntry[]) =>
		rows.filter((row) => {
			if (requestIds.has(row.client_request_id)) {
				return true;
			}
			return (
				options.includeAllUnresolvedOutbox === true &&
				row.status !== "acknowledged"
			);
		});
	const initialOutboxRows = selectOutboxRows(allOutboxRows);
	assertOutboxRowsCanBeRemoved(initialOutboxRows);
	initialOutboxRows.forEach((row) => requestIds.add(row.client_request_id));
	const targetOutboxIds = new Set(
		initialOutboxRows
			.map((row) => row.outbox_id)
			.filter((outboxId): outboxId is number =>
				Number.isFinite(outboxId),
			),
	);
	const journalSnapshots = new Map<string, string | null>();
	if (typeof localStorage !== "undefined") {
		requestIds.forEach((requestId) => {
			journalSnapshots.set(
				requestId,
				localStorage.getItem(
					`posa_invoice_intent_${encodeURIComponent(requestId)}`,
				),
			);
		});
	}

	let deletedOutboxRows = 0;
	let deletedLegacyRows = 0;
	try {
		// Remove the synchronous crash journal before the IndexedDB transaction so a
		// browser crash cannot resurrect a transaction the operator explicitly deleted.
		requestIds.forEach((requestId) =>
			removeInvoiceIntentJournalStrict(requestId),
		);
		await db.transaction("rw", writeQueueTable, outboxTable, async () => {
			const currentLegacyRows = (
				await writeQueueTable.bulkGet(legacyQueueIds)
			).filter((row): row is OfflineQueueEntry => !!row);
			if (currentLegacyRows.length !== legacyEntries.length) {
				throw new Error(
					"Invoice deletion targets changed before completion; no rows were deleted",
				);
			}
			assertLegacyRowsCanBeRemoved(currentLegacyRows);
			for (const expectedEntry of legacyEntries) {
				const currentEntry = currentLegacyRows.find(
					(row) => row.queue_id === expectedEntry.queue_id,
				);
				if (
					!currentEntry ||
					currentEntry.idempotency_key !==
						expectedEntry.idempotency_key ||
					!haveMatchingInvoiceOutboxIntent(
						currentEntry,
						expectedEntry,
					)
				) {
					throw new Error(
						"Invoice deletion payload changed before completion; no rows were deleted",
					);
				}
			}
			const currentOutboxRows = (
				(await outboxTable.toArray()) as InvoiceOutboxEntry[]
			).filter(
				(row) =>
					row.outbox_id !== undefined &&
					targetOutboxIds.has(row.outbox_id),
			);
			if (currentOutboxRows.length !== initialOutboxRows.length) {
				throw new Error(
					"Invoice outbox deletion targets changed before completion; no rows were deleted",
				);
			}
			assertOutboxRowsCanBeRemoved(currentOutboxRows);
			for (const expectedRow of initialOutboxRows) {
				const currentRow = currentOutboxRows.find(
					(row) => row.outbox_id === expectedRow.outbox_id,
				);
				if (
					!currentRow ||
					currentRow.client_request_id !==
						expectedRow.client_request_id ||
					!haveMatchingInvoiceOutboxIntent(currentRow, expectedRow)
				) {
					throw new Error(
						"Invoice outbox deletion payload changed before completion; no rows were deleted",
					);
				}
			}

			if (legacyQueueIds.length) {
				await writeQueueTable.bulkDelete(legacyQueueIds);
				deletedLegacyRows = currentLegacyRows.length;
			}
			const outboxIds = Array.from(targetOutboxIds);
			if (outboxIds.length) {
				await outboxTable.bulkDelete(outboxIds);
				deletedOutboxRows = currentOutboxRows.length;
			}
		});
	} catch (error) {
		if (typeof localStorage !== "undefined") {
			journalSnapshots.forEach((rawJournal, requestId) => {
				if (rawJournal !== null) {
					localStorage.setItem(
						`posa_invoice_intent_${encodeURIComponent(requestId)}`,
						rawJournal,
					);
				}
			});
		}
		throw error;
	}

	await refreshQueueMemory(INVOICE_ENTITY);
	return {
		legacy: deletedLegacyRows,
		outbox: deletedOutboxRows,
	};
}

export async function clearOfflineInvoices() {
	const legacyEntries = await getQueueEntries(INVOICE_ENTITY);
	return removeOfflineInvoiceTransactions({
		legacyEntries,
		includeAllUnresolvedOutbox: true,
	});
}

export async function deleteOfflineInvoice(index: number) {
	const legacyEntries = await getQueueEntries(INVOICE_ENTITY);
	const target = legacyEntries[index];
	if (!target) {
		return { legacy: 0, outbox: 0 };
	}
	return removeOfflineInvoiceTransactions({ legacyEntries: [target] });
}

export function getPendingOfflineInvoiceCount() {
	return getQueuedPayloadCount(INVOICE_ENTITY);
}

export async function getPendingInvoiceRecoveryCount() {
	const [outboxRows, legacyInvoices] = await Promise.all([
		getInvoiceOutboxRows(),
		Promise.resolve(getOfflineInvoices()),
	]);
	const pendingIds = new Set<string>();

	outboxRows.forEach((row, index) => {
		pendingIds.add(
			getInvoiceClientRequestId(row) ||
				`outbox:${row.outbox_id ?? index}`,
		);
	});
	legacyInvoices.forEach((entry, index) => {
		pendingIds.add(
			getInvoiceClientRequestId(entry) ||
				`legacy:${entry.queue_id ?? index}`,
		);
	});

	return pendingIds.size;
}

export function resetOfflineState() {
	pendingCoordinatorAcknowledgementIds.clear();
	memory.offline_invoices = [];
	memory.offline_customers = [];
	memory.offline_payments = [];
	memory.pos_last_sync_totals = { pending: 0, synced: 0, drafted: 0 };
	persist("pos_last_sync_totals");
}

export function setLastSyncTotals(totals: {
	pending: number;
	synced: number;
	drafted: number;
}) {
	memory.pos_last_sync_totals = totals;
	persist("pos_last_sync_totals");
}

export function getLastSyncTotals() {
	return memory.pos_last_sync_totals || { pending: 0, synced: 0, drafted: 0 };
}

export function consumeLastSyncTotals() {
	const totals = { ...getLastSyncTotals() };
	setLastSyncTotals({
		pending: totals.pending,
		synced: 0,
		drafted: 0,
	});
	return totals;
}

function publishInvoiceSyncTotals(totals: InvoiceSyncTotals) {
	const previous = getLastSyncTotals();
	const published = {
		pending: totals.pending,
		synced: Number(previous.synced || 0) + Number(totals.synced || 0),
		drafted: Number(previous.drafted || 0) + Number(totals.drafted || 0),
	};
	setLastSyncTotals(published);
	return totals;
}

async function removeOutboxOwnedLegacyInvoiceEntries() {
	const writeQueueTable = db.table("write_queue");
	const outboxTable = db.table("invoice_outbox");
	let removed = 0;
	await db.transaction("rw", writeQueueTable, outboxTable, async () => {
		const [outboxRows, legacyEntries] = await Promise.all([
			outboxTable.toArray() as Promise<InvoiceOutboxEntry[]>,
			writeQueueTable
				.where("entity_type")
				.equals(INVOICE_ENTITY)
				.toArray() as Promise<OfflineQueueEntry[]>,
		]);
		const outboxRowsByRequestId = new Map(
			outboxRows
				.map((row) => [getInvoiceClientRequestId(row), row] as const)
				.filter(([requestId]) => !!requestId),
		);
		const ownedQueueIds: number[] = [];

		for (const entry of legacyEntries) {
			const requestId = getInvoiceClientRequestId(entry);
			const outboxRow = requestId
				? outboxRowsByRequestId.get(requestId)
				: undefined;
			if (!requestId || !outboxRow || !entry.queue_id) continue;
			if (!haveMatchingInvoiceOutboxIntent(outboxRow, entry)) {
				throw new Error(
					`Invoice recovery request collision for ${requestId}; supervisor review is required`,
				);
			}
			// The outbox is authoritative for this exact immutable intent. Retain only
			// a live legacy lease that may already have an in-flight request; every
			// other compatibility row must disappear before the legacy claim pass.
			if (
				entry.status !== "syncing" ||
				isStaleWriteQueueSyncLease(entry)
			) {
				ownedQueueIds.push(Number(entry.queue_id));
			}
		}

		if (ownedQueueIds.length) {
			await writeQueueTable.bulkDelete(ownedQueueIds);
			removed = ownedQueueIds.length;
		}
	});

	if (removed) {
		await refreshQueueMemory(INVOICE_ENTITY);
	}
	return removed;
}

function unwrapLegacyInvoiceResponse(response: AnyRecord) {
	return typeof response?.message === "undefined"
		? response
		: response.message;
}

function isDefinitiveLegacySubmissionRejection(error: unknown) {
	const candidate = error as AnyRecord;
	const status = Number(
		candidate?.status ??
			candidate?.response?.status ??
			candidate?.httpStatus ??
			0,
	);
	if (
		!Number.isInteger(status) ||
		status < 400 ||
		status >= 500 ||
		[408, 409, 425, 429, 499].includes(status)
	) {
		return false;
	}

	const response = candidate?.responseJSON ?? candidate?.response?.data;
	if (!response || typeof response !== "object") {
		return false;
	}

	return Boolean(
		response.definitive_rejection === true ||
			String(response.exc_type || "").trim() ||
			String(response.exception || "").trim() ||
			String(response._server_messages || "").trim() ||
			String(response.exc || "").trim(),
	);
}

function assertLegacyInvoiceResponse(
	response: AnyRecord,
	expected: {
		docstatus: 0 | 1;
		doctype: "Sales Invoice" | "POS Invoice";
		clientRequestId: string;
		operation: string;
	},
) {
	const payload = unwrapLegacyInvoiceResponse(response);
	const name = String(payload?.name || "").trim();
	const doctype = String(payload?.doctype || "").trim();
	const responseRequestIds = [
		payload?.client_request_id,
		payload?.posa_client_request_id,
	]
		.map((value) => String(value || "").trim())
		.filter(Boolean);
	const providedStatuses = [payload?.docstatus, payload?.status].filter(
		(value) => value !== null && value !== undefined,
	);
	if (!payload || !name) {
		throw new Error(
			`${expected.operation} response did not include a document name`,
		);
	}
	if (
		!responseRequestIds.length ||
		responseRequestIds.some(
			(requestId) => requestId !== expected.clientRequestId,
		)
	) {
		throw new Error(
			`${expected.operation} response request identity did not match the queued invoice`,
		);
	}
	if (doctype !== expected.doctype) {
		throw new Error(
			`${expected.operation} response doctype ${doctype || "Unknown"} did not match queued ${expected.doctype}`,
		);
	}
	if (
		!providedStatuses.length ||
		providedStatuses.some(
			(value) =>
				value !== expected.docstatus &&
				(typeof value !== "string" ||
					value.trim() !== String(expected.docstatus)),
		)
	) {
		throw new Error(
			`${expected.operation} response did not consistently confirm docstatus ${expected.docstatus}`,
		);
	}
	return payload;
}

async function executeLegacyInvoiceSync(): Promise<InvoiceSyncTotals> {
	const outboxAcknowledgementIds =
		snapshotCoordinatorOutboxAcknowledgements();
	const outboxAcknowledged = outboxAcknowledgementIds.length;
	const completeSync = (totals: InvoiceSyncTotals) => {
		publishInvoiceSyncTotals(totals);
		commitCoordinatorOutboxAcknowledgements(outboxAcknowledgementIds);
		return totals;
	};
	await removeOutboxOwnedLegacyInvoiceEntries();
	await syncOfflineCustomers();
	// Customer sync may yield long enough for a previous lease to become stale;
	// close outbox ownership again immediately before the legacy claim pass.
	await removeOutboxOwnedLegacyInvoiceEntries();

	const invoices = getOfflineInvoices();
	if (!invoices.length) {
		const totals = {
			pending: await getPendingInvoiceRecoveryCount(),
			synced: outboxAcknowledged,
			drafted: 0,
		};
		return completeSync(totals);
	}

	if (isOffline()) {
		return completeSync({
			pending: await getPendingInvoiceRecoveryCount(),
			synced: outboxAcknowledged,
			drafted: 0,
		});
	}

	const claimedEntries = await claimRetryableQueueEntries(INVOICE_ENTITY);
	if (!claimedEntries.length) {
		const totals = {
			pending: await getPendingInvoiceRecoveryCount(),
			synced: outboxAcknowledged,
			drafted: 0,
		};
		return completeSync(totals);
	}

	let synced = outboxAcknowledged;
	let drafted = 0;

	for (const entry of claimedEntries) {
		const queuedInvoice = entry.payload;
		let expectedDoctype: "Sales Invoice" | "POS Invoice";
		let expectedRequestId: string;
		try {
			expectedDoctype = assertSupportedInvoiceOutboxEntry(
				queuedInvoice,
				"Legacy invoice recovery",
			);
			expectedRequestId = assertConsistentInvoiceRequestIdentity(
				queuedInvoice,
				"Legacy invoice recovery",
			);
			if (!expectedRequestId) {
				throw new Error(
					"Legacy invoice recovery requires a client request ID",
				);
			}
		} catch (integrityError) {
			await markWriteQueueEntryDeadLetter(
				INVOICE_ENTITY,
				Number(entry.queue_id),
				integrityError,
				entry.last_attempt_at,
			);
			continue;
		}

		let submitResponse: AnyRecord;
		try {
			submitResponse = await frappe.call({
				method: "posawesome.posawesome.api.invoices.submit_invoice",
				args: {
					invoice: queuedInvoice.invoice,
					data: queuedInvoice.data,
				},
			});
		} catch (submitError) {
			if (!isDefinitiveLegacySubmissionRejection(submitError)) {
				console.error(
					"Legacy invoice submission outcome is ambiguous; draft fallback was blocked pending authoritative reconciliation",
					submitError,
				);
				await markWriteQueueEntryFailed(
					INVOICE_ENTITY,
					Number(entry.queue_id),
					submitError,
					entry.last_attempt_at,
				);
				continue;
			}
			console.error(
				"Legacy invoice submission was definitively rejected; saving the compatibility draft",
				submitError,
			);
			try {
				const draftResponse = await frappe.call({
					method: "posawesome.posawesome.api.invoices.update_invoice",
					args: { data: queuedInvoice.invoice },
				});
				assertLegacyInvoiceResponse(draftResponse, {
					docstatus: 0,
					doctype: expectedDoctype,
					clientRequestId: expectedRequestId,
					operation: "Legacy invoice draft",
				});
				const markedDrafted = await markWriteQueueEntrySynced(
					INVOICE_ENTITY,
					Number(entry.queue_id),
					entry.last_attempt_at,
				);
				if (markedDrafted) {
					drafted += 1;
				}
			} catch (draftError) {
				console.error("Failed to save invoice as draft", draftError);
				await markWriteQueueEntryFailed(
					INVOICE_ENTITY,
					Number(entry.queue_id),
					draftError,
					entry.last_attempt_at,
				);
			}
			continue;
		}

		try {
			assertLegacyInvoiceResponse(submitResponse, {
				docstatus: 1,
				doctype: expectedDoctype,
				clientRequestId: expectedRequestId,
				operation: "Legacy invoice submission",
			});
			const markedSynced = await markWriteQueueEntrySynced(
				INVOICE_ENTITY,
				Number(entry.queue_id),
				entry.last_attempt_at,
			);
			if (markedSynced) synced += 1;
		} catch (invalidResponseError) {
			console.error(
				"Legacy invoice submission returned an invalid acknowledgement; draft fallback was blocked",
				invalidResponseError,
			);
			await markWriteQueueEntryFailed(
				INVOICE_ENTITY,
				Number(entry.queue_id),
				invalidResponseError,
				entry.last_attempt_at,
			);
		}
	}

	if (
		synced > 0 &&
		drafted === 0 &&
		(await getPendingInvoiceRecoveryCount()) === 0
	) {
		reduceCacheUsage();
	}

	const totals = {
		pending: await getPendingInvoiceRecoveryCount(),
		synced,
		drafted,
	};

	return completeSync(totals);
}

export function syncLegacyOfflineInvoices() {
	if (legacyInvoiceSyncPromise) {
		return legacyInvoiceSyncPromise;
	}

	legacyInvoiceSyncPromise = executeLegacyInvoiceSync().finally(() => {
		legacyInvoiceSyncPromise = null;
	});
	return legacyInvoiceSyncPromise;
}

export function syncOfflineInvoices() {
	if (invoiceRecoveryPromise) {
		return invoiceRecoveryPromise;
	}

	invoiceRecoveryPromise = (async () => {
		if (getInvoiceOutboxMode() === "coordinator") {
			const activeOutboxScope = resolveInvoiceOutboxOwnerScope();
			const outboxResult = await syncInvoiceOutboxResource(
				async (method, args = {}) => {
					const response = await frappe.call({ method, args });
					return typeof response?.message === "undefined"
						? response || {}
						: response.message;
				},
				activeOutboxScope,
			);
			recordCoordinatorInvoiceOutboxResult(outboxResult);
		}

		const legacyTotals = await syncLegacyOfflineInvoices();
		return {
			...legacyTotals,
			pending: await getPendingInvoiceRecoveryCount(),
		};
	})().finally(() => {
		invoiceRecoveryPromise = null;
	});

	return invoiceRecoveryPromise;
}
