import {
	db,
	memory,
	persist,
	registerPostHydrationTask,
	startupInitPromise,
} from "./db";
import { ensureOfflineQueueReady, getQueueEntries } from "./writeQueue";

type AnyRecord = Record<string, any>;

export type InvoiceOutboxMode = "off" | "dual_write" | "coordinator";
export type InvoiceOutboxStatus =
	| "pending"
	| "syncing"
	| "retrying"
	| "acknowledged"
	| "dead_letter";

export interface InvoiceOutboxEntry {
	outbox_id?: number;
	client_request_id: string;
	resource?: "invoice_outbox";
	status: InvoiceOutboxStatus;
	invoice: AnyRecord;
	data: AnyRecord;
	created_at: string;
	updated_at: string;
	next_retry_at: string | null;
	nextAttemptAt?: string | null;
	retry_count: number;
	last_error: string | null;
	invoice_name: string | null;
	acknowledged_at: string | null;
	sync_attempt_id?: string | null;
}

const TABLE = "invoice_outbox";
const JOURNAL_PREFIX = "posa_invoice_intent_";
const MAX_RETRY_COUNT = 5;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const SYNC_LEASE_MS = 5 * 60 * 1_000;
export const INVOICE_OUTBOX_DOCUMENT_TYPES = Object.freeze([
	"Sales Invoice",
	"POS Invoice",
] as const);
export type InvoiceOutboxDocumentType =
	(typeof INVOICE_OUTBOX_DOCUMENT_TYPES)[number];
const INVOICE_OUTBOX_DOCUMENT_TYPE_SET = new Set<string>(
	INVOICE_OUTBOX_DOCUMENT_TYPES,
);
const TERMINAL_STATUSES = new Set<InvoiceOutboxStatus>([
	"acknowledged",
	"dead_letter",
]);
const RESOLVED_STATUSES = new Set<InvoiceOutboxStatus>(["acknowledged"]);

function nowIso() {
	return new Date().toISOString();
}

function createSyncAttemptId() {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `invoice-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneSerializable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function stableStringify(value: any): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify(value[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function toErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error || "Unknown error");
	}
}

async function ensureOutboxReady() {
	if (!db.isOpen()) {
		await startupInitPromise;
	}
	if (!db.isOpen()) {
		await db.open();
	}
}

export function getInvoiceOutboxMode(): InvoiceOutboxMode {
	const mode = memory.invoice_outbox_mode;
	return mode === "dual_write" || mode === "coordinator" ? mode : "off";
}

export function setInvoiceOutboxMode(mode: InvoiceOutboxMode) {
	memory.invoice_outbox_mode = mode;
	persist("invoice_outbox_mode", mode);
}

export function shouldWriteInvoiceOutbox() {
	return getInvoiceOutboxMode() !== "off";
}

export function getInvoiceOutboxDocumentType(entry: AnyRecord) {
	const payload = entry?.payload || entry || {};
	return String(
		payload?.invoice?.doctype ||
			payload?.invoice?._force_invoice_doctype ||
			payload?.data?.doctype ||
			payload?.data?._force_invoice_doctype ||
			"",
	).trim();
}

function getInvoiceOutboxDocumentTypeSignals(entry: AnyRecord) {
	const payload = entry?.payload || entry || {};
	return [
		payload?.invoice?.doctype,
		payload?.invoice?._force_invoice_doctype,
		payload?.data?.doctype,
		payload?.data?._force_invoice_doctype,
	]
		.map((value) => String(value || "").trim())
		.filter(Boolean);
}

export function isSupportedInvoiceOutboxEntry(entry: AnyRecord) {
	const documentTypes = getInvoiceOutboxDocumentTypeSignals(entry);
	const uniqueDocumentTypes = new Set(documentTypes);
	return (
		documentTypes.length > 0 &&
		uniqueDocumentTypes.size === 1 &&
		documentTypes.every((documentType) =>
			INVOICE_OUTBOX_DOCUMENT_TYPE_SET.has(documentType),
		)
	);
}

export function assertSupportedInvoiceOutboxEntry(
	entry: AnyRecord,
	operation = "Invoice recovery",
) {
	const documentTypes = getInvoiceOutboxDocumentTypeSignals(entry);
	const documentType = documentTypes.join(", ") || "Unknown";
	if (!isSupportedInvoiceOutboxEntry(entry)) {
		throw new Error(
			`${operation} only supports Sales Invoice and POS Invoice and requires exactly one canonical document type; received ${documentType}`,
		);
	}
	return documentTypes[0] as InvoiceOutboxDocumentType;
}

export function assertConsistentInvoiceRequestIdentity(
	entry: AnyRecord,
	operation = "Invoice recovery",
) {
	const payload = entry?.payload || entry || {};
	const requestIds = [
		entry?.client_request_id,
		payload?.invoice?.posa_client_request_id,
		payload?.data?.idempotency_key,
		payload?.data?.client_request_id,
	]
		.map((value) => String(value || "").trim())
		.filter(Boolean);
	const uniqueRequestIds = new Set(requestIds);
	if (uniqueRequestIds.size > 1) {
		throw new Error(
			`${operation} request identity collision; all client request IDs must match`,
		);
	}
	return requestIds[0] || "";
}

export function getInvoiceClientRequestId(entry: AnyRecord) {
	const payload = entry?.payload || entry || {};
	return String(
		entry?.client_request_id ||
			payload?.invoice?.posa_client_request_id ||
			payload?.data?.idempotency_key ||
			payload?.data?.client_request_id ||
			"",
	).trim();
}

function journalKey(clientRequestId: string) {
	return `${JOURNAL_PREFIX}${encodeURIComponent(clientRequestId)}`;
}

function getInvoiceIntentFingerprint(entry: AnyRecord) {
	const payload = entry?.payload || entry || {};
	return stableStringify({
		invoice: payload?.invoice || {},
		data: payload?.data || {},
	});
}

export function haveMatchingInvoiceOutboxIntent(
	left: AnyRecord,
	right: AnyRecord,
) {
	return (
		getInvoiceIntentFingerprint(left) === getInvoiceIntentFingerprint(right)
	);
}

function updateInvoiceIntentJournalCustomer(
	clientRequestId: string,
	oldName: string,
	newName: string,
) {
	if (typeof localStorage === "undefined") return;
	const key = journalKey(clientRequestId);
	const rawEntry = localStorage.getItem(key);
	if (!rawEntry) return;

	try {
		const entry = JSON.parse(rawEntry);
		if (entry?.invoice?.customer !== oldName) return;
		entry.invoice.customer = newName;
		if (entry.invoice.customer_name) {
			entry.invoice.customer_name = newName;
		}
		localStorage.setItem(key, JSON.stringify(entry));
	} catch (error) {
		console.warn("Failed to update invoice recovery journal customer", {
			clientRequestId,
			error: toErrorMessage(error),
		});
	}
}

export function persistInvoiceIntentJournal(entry: AnyRecord) {
	const cleanEntry = cloneSerializable(entry);
	assertSupportedInvoiceOutboxEntry(cleanEntry, "Invoice intent journal");
	const clientRequestId = assertConsistentInvoiceRequestIdentity(
		cleanEntry,
		"Invoice intent journal",
	);
	if (!clientRequestId) {
		throw new Error("Invoice intent journal requires a client_request_id");
	}
	if (typeof localStorage !== "undefined") {
		localStorage.setItem(
			journalKey(clientRequestId),
			JSON.stringify(cleanEntry),
		);
	}
	return clientRequestId;
}

export function removeInvoiceIntentJournal(clientRequestId: string) {
	const normalizedId = String(clientRequestId || "").trim();
	if (!normalizedId || typeof localStorage === "undefined") {
		return true;
	}
	const key = journalKey(normalizedId);
	localStorage.removeItem(key);
	return localStorage.getItem(key) === null;
}

export function removeInvoiceIntentJournalStrict(clientRequestId: string) {
	if (!removeInvoiceIntentJournal(clientRequestId)) {
		throw new Error(
			`Invoice recovery journal ${clientRequestId} could not be removed`,
		);
	}
}

async function recoverInvoiceIntentJournal() {
	if (typeof localStorage === "undefined") return;
	const entries: AnyRecord[] = [];
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (!key?.startsWith(JOURNAL_PREFIX)) continue;
		try {
			const entry = JSON.parse(localStorage.getItem(key) || "null");
			if (entry) entries.push(entry);
		} catch (error) {
			console.warn(
				"Ignoring invalid invoice intent journal entry",
				error,
			);
		}
	}
	for (const entry of entries) {
		if (!isSupportedInvoiceOutboxEntry(entry)) {
			console.error(
				"Invoice recovery journal entry requires manual review because its document type is unsupported",
				{
					clientRequestId: getInvoiceClientRequestId(entry),
					documentType:
						getInvoiceOutboxDocumentType(entry) || "Unknown",
				},
			);
			continue;
		}
		try {
			await enqueueInvoiceOutboxEntry(entry);
		} catch (error) {
			console.error("Failed to restore invoice recovery journal entry", {
				clientRequestId: getInvoiceClientRequestId(entry),
				error: toErrorMessage(error),
			});
		}
	}
}

export async function enqueueInvoiceOutboxEntry(entry: AnyRecord) {
	const cleanEntry = cloneSerializable(entry);
	assertSupportedInvoiceOutboxEntry(cleanEntry, "Invoice outbox");
	const clientRequestId = assertConsistentInvoiceRequestIdentity(
		cleanEntry,
		"Invoice outbox",
	);
	if (!clientRequestId) {
		throw new Error("Invoice outbox entry requires a client_request_id");
	}
	await ensureOutboxReady();

	const table = db.table(TABLE);
	return db.transaction("rw", table, async () => {
		const existing = (await table
			.where("client_request_id")
			.equals(clientRequestId)
			.first()) as InvoiceOutboxEntry | undefined;
		if (existing) {
			if (!haveMatchingInvoiceOutboxIntent(existing, cleanEntry)) {
				throw new Error(
					`Invoice outbox request collision for ${clientRequestId}; the saved payload is immutable`,
				);
			}
			return existing;
		}

		const timestamp = nowIso();
		const outboxEntry: InvoiceOutboxEntry = {
			client_request_id: clientRequestId,
			resource: "invoice_outbox",
			status: "pending",
			invoice: cleanEntry.invoice,
			data: cleanEntry.data || {},
			created_at: timestamp,
			updated_at: timestamp,
			next_retry_at: null,
			nextAttemptAt: null,
			retry_count: 0,
			last_error: null,
			invoice_name: null,
			acknowledged_at: null,
			sync_attempt_id: null,
		};
		const outboxId = await table.add(outboxEntry);
		return { ...outboxEntry, outbox_id: outboxId };
	});
}

export async function updateInvoiceOutboxCustomer(
	oldName: string,
	newName: string,
) {
	const previousName = String(oldName || "").trim();
	const canonicalName = String(newName || "").trim();
	if (!previousName || !canonicalName || previousName === canonicalName) {
		return 0;
	}

	await ensureOutboxReady();
	const table = db.table(TABLE);
	const updatedRows: InvoiceOutboxEntry[] = [];

	await db.transaction("rw", table, async () => {
		const rows = (await table.toArray()) as InvoiceOutboxEntry[];
		for (const row of rows) {
			if (
				RESOLVED_STATUSES.has(row.status) ||
				row?.invoice?.customer !== previousName
			) {
				continue;
			}

			const updatedRow: InvoiceOutboxEntry = {
				...row,
				invoice: {
					...row.invoice,
					customer: canonicalName,
					...(row.invoice.customer_name
						? { customer_name: canonicalName }
						: {}),
				},
				updated_at: nowIso(),
			};
			await table.put(updatedRow);
			updatedRows.push(updatedRow);
		}
	});

	updatedRows.forEach((row) =>
		updateInvoiceIntentJournalCustomer(
			row.client_request_id,
			previousName,
			canonicalName,
		),
	);
	return updatedRows.length;
}

let coordinatorMigrationPromise: Promise<{
	mode: "coordinator";
	migrated: number;
	skipped: number;
}> | null = null;

/**
 * Copies retryable legacy invoice rows into the durable outbox before enabling
 * coordinator mode. Legacy rows remain in place until the coordinator's
 * compatibility phase confirms that the outbox owns their canonical request ID.
 */
export function migrateInvoiceOutboxModeToCoordinator(
	legacyEntries?: AnyRecord[],
) {
	if (coordinatorMigrationPromise) {
		return coordinatorMigrationPromise;
	}

	coordinatorMigrationPromise = (async () => {
		await ensureOfflineQueueReady();
		await ensureOutboxReady();
		const sourceEntries =
			legacyEntries || (await getQueueEntries("invoice"));
		let migrated = 0;
		let skipped = 0;

		for (const legacyEntry of sourceEntries) {
			if (["dead_letter", "synced"].includes(legacyEntry?.status)) {
				skipped += 1;
				continue;
			}

			const payload = legacyEntry?.payload || legacyEntry;
			if (
				!getInvoiceClientRequestId(payload) ||
				!isSupportedInvoiceOutboxEntry(payload)
			) {
				skipped += 1;
				continue;
			}
			await enqueueInvoiceOutboxEntry(payload);
			migrated += 1;
		}

		setInvoiceOutboxMode("coordinator");
		return {
			mode: "coordinator" as const,
			migrated,
			skipped,
		};
	})().finally(() => {
		coordinatorMigrationPromise = null;
	});

	return coordinatorMigrationPromise;
}

export async function getInvoiceOutboxRows(
	options: { includeTerminal?: boolean } = {},
) {
	await ensureOutboxReady();
	const rows = (await db
		.table(TABLE)
		.orderBy("created_at")
		.toArray()) as InvoiceOutboxEntry[];
	return rows.filter(
		(row) => options.includeTerminal || !RESOLVED_STATUSES.has(row.status),
	);
}

export async function getPendingInvoiceOutboxCount() {
	return (await getInvoiceOutboxRows()).length;
}

function assertMatchingInvoiceIntent(
	storedEntry: AnyRecord,
	expectedEntry: AnyRecord,
	clientRequestId: string,
	operation: string,
) {
	const expectedRequestId = assertConsistentInvoiceRequestIdentity(
		expectedEntry,
		operation,
	);
	const storedRequestId = assertConsistentInvoiceRequestIdentity(
		storedEntry,
		operation,
	);
	if (
		!expectedRequestId ||
		expectedRequestId !== clientRequestId ||
		storedRequestId !== clientRequestId
	) {
		throw new Error(
			`${operation} request identity did not match ${clientRequestId}`,
		);
	}
	const expectedDocumentType = assertSupportedInvoiceOutboxEntry(
		expectedEntry,
		operation,
	);
	const storedDocumentType = assertSupportedInvoiceOutboxEntry(
		storedEntry,
		operation,
	);
	if (storedDocumentType !== expectedDocumentType) {
		throw new Error(`${operation} document type changed before completion`);
	}
	if (!haveMatchingInvoiceOutboxIntent(storedEntry, expectedEntry)) {
		throw new Error(
			`${operation} payload changed before completion; supervisor review is required`,
		);
	}
}

function getInvoiceIntentJournalRaw(clientRequestId: string) {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(journalKey(clientRequestId));
}

function assertMatchingInvoiceIntentJournal(
	rawJournal: string | null,
	expectedEntry: AnyRecord,
	clientRequestId: string,
) {
	if (rawJournal === null) return;
	let journalEntry: AnyRecord;
	try {
		journalEntry = JSON.parse(rawJournal);
	} catch {
		throw new Error(
			`Invoice outbox removal found an invalid recovery journal for ${clientRequestId}`,
		);
	}
	assertMatchingInvoiceIntent(
		journalEntry,
		expectedEntry,
		clientRequestId,
		"Invoice outbox removal",
	);
}

export type RemovableInvoiceOutboxStatus = "pending";

export async function removeInvoiceOutboxEntry(
	clientRequestId: string,
	expectedEntry: AnyRecord,
	expectedStatus: RemovableInvoiceOutboxStatus,
) {
	const normalizedId = String(clientRequestId || "").trim();
	if (!normalizedId) {
		throw new Error("Invoice outbox removal requires a client request ID");
	}
	if (expectedStatus !== "pending") {
		throw new Error(
			`Invoice outbox removal only permits verified unsent pending rows; received ${expectedStatus}`,
		);
	}
	assertSupportedInvoiceOutboxEntry(expectedEntry, "Invoice outbox removal");
	if (
		assertConsistentInvoiceRequestIdentity(
			expectedEntry,
			"Invoice outbox removal",
		) !== normalizedId
	) {
		throw new Error(
			"Invoice outbox removal request identity did not match",
		);
	}
	await ensureOutboxReady();
	const rawJournal = getInvoiceIntentJournalRaw(normalizedId);
	assertMatchingInvoiceIntentJournal(rawJournal, expectedEntry, normalizedId);
	const table = db.table(TABLE);

	try {
		return await db.transaction("rw", table, async () => {
			const current = (await table
				.where("client_request_id")
				.equals(normalizedId)
				.first()) as InvoiceOutboxEntry | undefined;
			if (!current) {
				removeInvoiceIntentJournalStrict(normalizedId);
				return 0;
			}
			assertMatchingInvoiceIntent(
				current,
				expectedEntry,
				normalizedId,
				"Invoice outbox removal",
			);
			if (current.status !== expectedStatus) {
				throw new Error(
					`Invoice outbox removal expected ${expectedStatus} but found ${current.status}; the row was not deleted`,
				);
			}
			if (!Number.isFinite(current.outbox_id)) {
				throw new Error(
					"Invoice outbox removal could not resolve its exact row",
				);
			}
			removeInvoiceIntentJournalStrict(normalizedId);
			await table.delete(current.outbox_id);
			return 1;
		});
	} catch (error) {
		if (rawJournal !== null && typeof localStorage !== "undefined") {
			localStorage.setItem(journalKey(normalizedId), rawJournal);
		}
		throw error;
	}
}

export interface SubmittedInvoiceOutboxAcknowledgement {
	acknowledged: true;
	client_request_id: string;
	invoice: {
		name: string;
		doctype: InvoiceOutboxDocumentType;
		docstatus?: number | string;
		status?: number | string;
	};
	docstatus?: number | string;
	status?: number | string;
}

export async function finalizeAcknowledgedInvoiceOutboxEntry(
	clientRequestId: string,
	expectedEntry: AnyRecord,
	acknowledgement: SubmittedInvoiceOutboxAcknowledgement,
) {
	const normalizedId = String(clientRequestId || "").trim();
	if (!normalizedId) {
		throw new Error(
			"Invoice outbox finalization requires a client request ID",
		);
	}
	assertSupportedInvoiceOutboxEntry(
		expectedEntry,
		"Invoice outbox finalization",
	);
	if (
		assertConsistentInvoiceRequestIdentity(
			expectedEntry,
			"Invoice outbox finalization",
		) !== normalizedId
	) {
		throw new Error(
			"Invoice outbox finalization request identity did not match",
		);
	}
	await ensureOutboxReady();
	const table = db.table(TABLE);
	const finalized = await db.transaction("rw", table, async () => {
		const current = (await table
			.where("client_request_id")
			.equals(normalizedId)
			.first()) as InvoiceOutboxEntry | undefined;
		if (!current) {
			throw new Error(
				`Invoice outbox finalization could not find ${normalizedId}; its recovery journal was retained`,
			);
		}
		assertMatchingInvoiceIntent(
			current,
			expectedEntry,
			normalizedId,
			"Invoice outbox finalization",
		);
		assertSubmittedOutboxAcknowledgement(current, acknowledgement);
		if (current.status === "acknowledged") {
			if (
				current.invoice_name !==
				String(acknowledgement.invoice.name).trim()
			) {
				throw new Error(
					"Invoice outbox finalization conflicted with the stored acknowledged invoice",
				);
			}
			return current;
		}
		const acknowledgedRow = markOutboxAcknowledged(
			current,
			acknowledgement,
		);
		await table.put(acknowledgedRow);
		return acknowledgedRow;
	});
	removeInvoiceIntentJournalStrict(normalizedId);
	return finalized;
}

function shouldAttempt(row: InvoiceOutboxEntry) {
	if (TERMINAL_STATUSES.has(row.status)) return false;
	if (row.status === "syncing") {
		const claimedAt = Date.parse(row.updated_at);
		return (
			!Number.isFinite(claimedAt) ||
			Date.now() - claimedAt >= SYNC_LEASE_MS
		);
	}
	if (!row.next_retry_at) return true;
	const nextRetryAt = Date.parse(row.next_retry_at);
	return !Number.isFinite(nextRetryAt) || nextRetryAt <= Date.now();
}

function computeBackoffMs(retryCount: number) {
	const multiplier = 2 ** Math.max(0, retryCount - 1);
	return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * multiplier);
}

function markOutboxAcknowledged(
	row: InvoiceOutboxEntry,
	response: AnyRecord,
): InvoiceOutboxEntry {
	const timestamp = nowIso();
	return {
		...row,
		status: "acknowledged",
		resource: "invoice_outbox" as const,
		updated_at: timestamp,
		acknowledged_at: timestamp,
		last_error: null,
		next_retry_at: null,
		nextAttemptAt: null,
		invoice_name: String(response.invoice.name).trim(),
		sync_attempt_id: null,
	};
}

function markOutboxUnsupported(
	row: InvoiceOutboxEntry,
	error?: unknown,
): InvoiceOutboxEntry {
	const documentType = getInvoiceOutboxDocumentType(row) || "Unknown";
	return {
		...row,
		resource: "invoice_outbox" as const,
		status: "dead_letter",
		updated_at: nowIso(),
		next_retry_at: null,
		nextAttemptAt: null,
		last_error:
			error === undefined
				? `Automatic recovery is not supported for ${documentType}; supervisor review is required`
				: toErrorMessage(error),
		sync_attempt_id: null,
	};
}

function assertStoredInvoiceOutboxIntegrity(row: InvoiceOutboxEntry) {
	assertSupportedInvoiceOutboxEntry(row, "Invoice outbox replay");
	const payloadRequestId = assertConsistentInvoiceRequestIdentity(
		row,
		"Invoice outbox replay",
	);
	if (!payloadRequestId || payloadRequestId !== row.client_request_id) {
		throw new Error(
			"Invoice outbox replay request identity did not match its stored key",
		);
	}
}

function isSubmittedStatus(value: unknown) {
	return value === 1 || (typeof value === "string" && value.trim() === "1");
}

function assertSubmittedOutboxAcknowledgement(
	row: InvoiceOutboxEntry,
	response: AnyRecord,
) {
	const requestedDocumentType = assertSupportedInvoiceOutboxEntry(
		row,
		"Invoice outbox acknowledgement",
	);
	const responseRequestId = String(response?.client_request_id || "").trim();
	const invoice = response?.invoice || {};
	const invoiceName = String(invoice?.name || "").trim();
	const documentType = String(invoice?.doctype || "").trim();
	const providedStatuses = [
		invoice?.docstatus,
		invoice?.status,
		response?.docstatus,
		response?.status,
	].filter((value) => value !== null && value !== undefined && value !== "");

	if (response?.acknowledged !== true) {
		throw new Error("Invoice outbox response was not acknowledged");
	}
	if (!responseRequestId || responseRequestId !== row.client_request_id) {
		throw new Error(
			"Invoice outbox acknowledgement request ID did not match",
		);
	}
	if (!invoiceName) {
		throw new Error(
			"Invoice outbox acknowledgement did not include an invoice name",
		);
	}
	if (!INVOICE_OUTBOX_DOCUMENT_TYPE_SET.has(documentType)) {
		throw new Error(
			"Invoice outbox acknowledgement returned an unsupported document type",
		);
	}
	if (documentType !== requestedDocumentType) {
		throw new Error(
			`Invoice outbox acknowledgement document type ${documentType} did not match requested ${requestedDocumentType}`,
		);
	}
	if (
		!providedStatuses.length ||
		providedStatuses.some((value) => !isSubmittedStatus(value))
	) {
		throw new Error(
			"Invoice outbox acknowledgement did not confirm a submitted invoice",
		);
	}
}

function markOutboxFailed(
	row: InvoiceOutboxEntry,
	error: unknown,
): InvoiceOutboxEntry {
	const retryCount = Number(row.retry_count || 0) + 1;
	const status: InvoiceOutboxStatus =
		retryCount >= MAX_RETRY_COUNT ? "dead_letter" : "retrying";
	const nextRetryAt =
		status === "dead_letter"
			? null
			: new Date(Date.now() + computeBackoffMs(retryCount)).toISOString();
	return {
		...row,
		resource: "invoice_outbox" as const,
		status,
		retry_count: retryCount,
		updated_at: nowIso(),
		next_retry_at: nextRetryAt,
		nextAttemptAt: nextRetryAt,
		last_error: toErrorMessage(error),
		sync_attempt_id: null,
	};
}

export interface InvoiceOutboxSyncResult {
	resourceId: "invoice_outbox";
	status: "fresh" | "stale" | "error";
	lastError: string | null;
	watermark: string;
	lastSyncedAt: string;
	consecutiveFailures: number;
	nextRetryAt: string | null;
	pendingCount: number;
	acknowledged: number;
	acknowledgedRequestIds: string[];
}

let invoiceOutboxSyncPromise: Promise<InvoiceOutboxSyncResult> | null = null;

async function claimInvoiceOutboxRows() {
	const table = db.table(TABLE);
	const claimedRows: InvoiceOutboxEntry[] = [];
	await db.transaction("rw", table, async () => {
		const rows = ((await table.toArray()) as InvoiceOutboxEntry[]).sort(
			(left, right) => left.created_at.localeCompare(right.created_at),
		);
		for (const current of rows) {
			if (current.status === "acknowledged") continue;
			try {
				assertStoredInvoiceOutboxIntegrity(current);
			} catch (error) {
				if (current.status !== "dead_letter") {
					await table.put(markOutboxUnsupported(current, error));
				}
				continue;
			}
			if (!shouldAttempt(current)) continue;

			const claimTimestamp = nowIso();
			const claimed: InvoiceOutboxEntry = {
				...current,
				resource: "invoice_outbox",
				status: "syncing",
				updated_at: claimTimestamp,
				nextAttemptAt: current.next_retry_at || null,
				sync_attempt_id: createSyncAttemptId(),
			};
			await table.put(claimed);
			claimedRows.push(claimed);
		}
	});
	return claimedRows;
}

type InvoiceOutboxClaimCompletion =
	| "acknowledged"
	| "failed"
	| "already_acknowledged"
	| "stale";

async function completeInvoiceOutboxClaim(
	claimed: InvoiceOutboxEntry,
	completion:
		| { kind: "acknowledged"; response: AnyRecord }
		| { kind: "failed"; error: unknown },
): Promise<InvoiceOutboxClaimCompletion> {
	const table = db.table(TABLE);
	return db.transaction("rw", table, async () => {
		const current = (await table.get(claimed.outbox_id)) as
			| InvoiceOutboxEntry
			| undefined;
		if (!current) return "stale";
		if (current.status === "acknowledged") {
			return "already_acknowledged";
		}
		if (
			current.status !== "syncing" ||
			!claimed.sync_attempt_id ||
			current.sync_attempt_id !== claimed.sync_attempt_id
		) {
			return "stale";
		}
		assertMatchingInvoiceIntent(
			current,
			claimed,
			claimed.client_request_id,
			"Invoice outbox claim completion",
		);

		if (completion.kind === "acknowledged") {
			assertSubmittedOutboxAcknowledgement(current, completion.response);
			await table.put(
				markOutboxAcknowledged(current, completion.response),
			);
			return "acknowledged";
		}

		await table.put(markOutboxFailed(current, completion.error));
		return "failed";
	});
}

async function executeInvoiceOutboxSync(
	callOfflineSyncMethod: (
		method: string,
		args?: Record<string, any>,
	) => Promise<any>,
): Promise<InvoiceOutboxSyncResult> {
	await migrateInvoiceOutboxModeToCoordinator();
	await ensureOutboxReady();
	const terminalRows = await getInvoiceOutboxRows({ includeTerminal: true });
	for (const row of terminalRows) {
		if (row.status === "acknowledged") {
			removeInvoiceIntentJournalStrict(row.client_request_id);
		}
	}
	let acknowledged = 0;
	const acknowledgedRequestIds: string[] = [];
	let failed = 0;
	const claimedRows = await claimInvoiceOutboxRows();

	for (const claimed of claimedRows) {
		let response: AnyRecord;
		try {
			response = await callOfflineSyncMethod(
				"posawesome.posawesome.api.offline_sync.invoices.submit_invoice_outbox_entry",
				{
					client_request_id: claimed.client_request_id,
					invoice: claimed.invoice,
					data: claimed.data,
				},
			);
			assertSubmittedOutboxAcknowledgement(claimed, response || {});
		} catch (error) {
			const completion = await completeInvoiceOutboxClaim(claimed, {
				kind: "failed",
				error,
			});
			if (completion === "failed") failed += 1;
			continue;
		}

		const completion = await completeInvoiceOutboxClaim(claimed, {
			kind: "acknowledged",
			response,
		});
		if (completion === "acknowledged") {
			// The acknowledged row is deliberately retained before journal cleanup.
			// A storage failure must reject this sync rather than silently leave an
			// intent that a later hydration could resurrect.
			removeInvoiceIntentJournalStrict(claimed.client_request_id);
			acknowledged += 1;
			acknowledgedRequestIds.push(claimed.client_request_id);
		}
	}

	const unresolvedRows = await getInvoiceOutboxRows();
	const pending = unresolvedRows.length;
	const deadLetterCount = unresolvedRows.filter(
		(row) => row.status === "dead_letter",
	).length;
	const waitingRetryRows = unresolvedRows.filter(
		(row) => row.status === "retrying" && !shouldAttempt(row),
	);
	const status =
		failed || deadLetterCount
			? "error"
			: unresolvedRows.length
				? "stale"
				: "fresh";
	const lastError = failed
		? `${failed} invoice outbox entr${failed === 1 ? "y" : "ies"} failed`
		: deadLetterCount
			? `${deadLetterCount} invoice outbox entr${deadLetterCount === 1 ? "y requires" : "ies require"} supervisor review`
			: waitingRetryRows.length
				? `${waitingRetryRows.length} invoice outbox entr${waitingRetryRows.length === 1 ? "y is" : "ies are"} waiting for retry`
				: unresolvedRows.length
					? `${unresolvedRows.length} invoice outbox entr${unresolvedRows.length === 1 ? "y remains" : "ies remain"} pending`
					: null;
	const nextRetryAt =
		waitingRetryRows
			.map((row) => row.next_retry_at)
			.filter((value): value is string => !!value)
			.sort()[0] || null;
	const timestamp = nowIso();
	return {
		resourceId: "invoice_outbox",
		status,
		lastError,
		watermark: timestamp,
		lastSyncedAt: timestamp,
		consecutiveFailures: status === "error" ? 1 : 0,
		nextRetryAt,
		pendingCount: pending,
		acknowledged,
		acknowledgedRequestIds,
	};
}

export function syncInvoiceOutboxResource(
	callOfflineSyncMethod: (
		method: string,
		args?: Record<string, any>,
	) => Promise<any>,
) {
	if (invoiceOutboxSyncPromise) {
		return invoiceOutboxSyncPromise;
	}

	invoiceOutboxSyncPromise = executeInvoiceOutboxSync(
		callOfflineSyncMethod,
	).finally(() => {
		invoiceOutboxSyncPromise = null;
	});
	return invoiceOutboxSyncPromise;
}

registerPostHydrationTask(recoverInvoiceIntentJournal);
