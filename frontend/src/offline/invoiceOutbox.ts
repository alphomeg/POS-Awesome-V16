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
	| "waiting_owner"
	| "requires_reauthorization"
	| "requires_supervisor_review"
	| "acknowledged"
	| "dead_letter";

/**
 * Explicit server outcomes for a signed offline cash sale. These are not
 * transport failures: the immutable sale is retained and awaits a deliberate
 * PIN-backed replacement authorization.
 */
export type InvoiceOutboxResolution =
	| "requires_reauthorization"
	| "requires_supervisor_review";

/**
 * A durable, non-secret recovery instruction. It is deliberately narrower
 * than a server diagnostic: the browser may use it to stop asking for PINs
 * when the current POS policy can no longer authorize the immutable sale.
 */
export type InvoiceOutboxRecoveryAction = "manual_backoffice_review";

export type InvoiceOutboxOwnerScope = {
	owner_user?: string | null;
	pos_profile?: string | null;
	company?: string | null;
};

export interface InvoiceOutboxEntry {
	outbox_id?: number;
	client_request_id: string;
	resource?: "invoice_outbox";
	status: InvoiceOutboxStatus;
	invoice: AnyRecord;
	data: AnyRecord;
	/**
	 * Immutable routing scope captured when this sale is first persisted. It is
	 * deliberately kept outside the invoice payload so it is never sent to the
	 * server as business data.
	 */
	owner_scope_version?: 1;
	/** Original cashier provenance. This value is never changed after enqueue. */
	owner_user?: string | null;
	pos_profile?: string | null;
	company?: string | null;
	/**
	 * Effective replay user after a supervisor has reauthorized this exact row.
	 * It is written only by the guarded bearer-replacement compare-and-set; the
	 * original owner_user remains the audit/provenance identity.
	 */
	recovery_owner_user?: string | null;
	/** A short-lived server ticket. It is durable only in IndexedDB, never the journal. */
	offline_sale_authorization?: string | null;
	/** Non-secret recovery metadata; it never changes the signed invoice command. */
	recovery_action?: InvoiceOutboxRecoveryAction | null;
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

/** A display-safe outbox row. It never carries the offline-sale bearer. */
export type RedactedInvoiceOutboxEntry = Omit<
	InvoiceOutboxEntry,
	"offline_sale_authorization"
> & {
	offline_sale_authorization: null;
	/** A display-only marker so callers can list ticketed rows without a bearer. */
	has_offline_sale_authorization: boolean;
};

/**
 * A short-lived command for one immediate online reauthorization call. Callers
 * must keep this in a local variable, never reactive UI state or a store.
 */
export interface InvoiceOutboxReauthorizationCommand {
	client_request_id: string;
	document_type: InvoiceOutboxDocumentType;
	invoice: AnyRecord;
	data: AnyRecord;
	offline_sale_authorization: string;
}

export interface GetInvoiceOutboxRowsOptions {
	includeTerminal?: boolean;
	redactOfflineSaleAuthorization?: boolean;
}

const TABLE = "invoice_outbox";
const JOURNAL_PREFIX = "posa_invoice_intent_";
const MAX_RETRY_COUNT = 5;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const SYNC_LEASE_MS = 5 * 60 * 1_000;
const OWNER_SCOPE_VERSION = 1 as const;
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
const ACTION_REQUIRED_STATUSES = new Set<InvoiceOutboxStatus>([
	"requires_reauthorization",
	"requires_supervisor_review",
]);
const INVOICE_OUTBOX_RESOLUTION_SET = new Set<InvoiceOutboxResolution>([
	"requires_reauthorization",
	"requires_supervisor_review",
]);
const MANUAL_BACKOFFICE_REASON_SET = new Set([
	"manual_backoffice_review",
	"current_policy_rejects_command",
]);
const OFFLINE_CASH_SALE_RETRY_ERROR =
	"Offline cash sale could not sync. It remains queued and will retry when the connection is available.";
const OFFLINE_CASH_SALE_MANUAL_REVIEW_ERROR =
	"Offline cash sale requires back-office supervisor review before it can be resolved.";
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

function normalizeOwnerScopeValue(value: unknown): string | null {
	const normalized = String(value || "").trim();
	return normalized || null;
}

function getEntryPayload(entry: AnyRecord = {}) {
	return entry?.payload || entry || {};
}

function hasRecordedInvoiceOutboxOwnerScope(entry: AnyRecord = {}) {
	const payload = getEntryPayload(entry);
	return (
		payload?.owner_scope_version === OWNER_SCOPE_VERSION ||
		Object.prototype.hasOwnProperty.call(payload, "owner_user") ||
		Object.prototype.hasOwnProperty.call(payload, "pos_profile") ||
		Object.prototype.hasOwnProperty.call(payload, "company")
	);
}

function normalizeInvoiceOutboxOwnerScope(
	scope: InvoiceOutboxOwnerScope = {},
): Required<InvoiceOutboxOwnerScope> {
	return {
		owner_user: normalizeOwnerScopeValue(scope.owner_user),
		pos_profile: normalizeOwnerScopeValue(scope.pos_profile),
		company: normalizeOwnerScopeValue(scope.company),
	};
}

/**
 * Resolves the active session/profile scope used to decide which durable sale
 * intents may be replayed. The explicit input is used by the sync coordinator;
 * the runtime fallback keeps the legacy `syncOfflineInvoices()` entry point
 * correctly scoped as well.
 */
export function resolveInvoiceOutboxOwnerScope(
	scope: InvoiceOutboxOwnerScope = {},
): Required<InvoiceOutboxOwnerScope> {
	const frappeContext = (globalThis as any)?.frappe || {};
	const runtimeProfile = frappeContext?.boot?.pos_profile || {};
	return normalizeInvoiceOutboxOwnerScope({
		owner_user: scope.owner_user ?? frappeContext?.session?.user,
		pos_profile: scope.pos_profile ?? runtimeProfile?.name,
		company: scope.company ?? runtimeProfile?.company,
	});
}

function getInvoiceOutboxOwnerScopeFromEntry(entry: AnyRecord = {}) {
	const payload = getEntryPayload(entry);
	return normalizeInvoiceOutboxOwnerScope({
		owner_user: payload?.owner_user,
		pos_profile:
			payload?.pos_profile ||
			payload?.invoice?.pos_profile ||
			payload?.data?.pos_profile,
		company:
			payload?.company ||
			payload?.invoice?.company ||
			payload?.data?.company,
	});
}

/**
 * Returns the effective replay scope for a durable outbox row. A supervisor
 * recovery may replace only the effective user; the original user remains the
 * row's immutable provenance.
 */
export function getInvoiceOutboxEffectiveReplayScope(
	entry: AnyRecord = {},
) {
	const payload = getEntryPayload(entry);
	const originalScope = getInvoiceOutboxOwnerScopeFromEntry(payload);
	return {
		...originalScope,
		owner_user:
			normalizeOwnerScopeValue(payload?.recovery_owner_user) ||
			originalScope.owner_user,
	};
}

/**
 * Reports whether an outbox row carries (or was redacted from carrying) an
 * offline cash-sale ticket. The redacted marker is intentionally non-secret
 * and lets recovery UI enumerate ticketed rows without loading a bearer.
 */
export function hasInvoiceOutboxOfflineSaleAuthorization(
	entry: AnyRecord = {},
) {
	const payload = getEntryPayload(entry);
	return (
		Boolean(String(payload?.offline_sale_authorization || "").trim()) ||
		payload?.has_offline_sale_authorization === true
	);
}

/**
 * Attaches the immutable owner/profile/company routing metadata before a sale
 * is written to the outbox, journal, or compatibility queue. Existing scoped
 * records retain their original scope during reload and migration.
 */
export function attachInvoiceOutboxOwnerScope<T extends AnyRecord>(
	entry: T,
	options: { preserveLegacyUnscoped?: boolean } = {},
): T & {
	owner_scope_version?: 1;
	owner_user?: string | null;
	pos_profile?: string | null;
	company?: string | null;
} {
	const payload = getEntryPayload(entry);
	if (Object.prototype.hasOwnProperty.call(payload, "recovery_owner_user")) {
		throw new Error(
			"Invoice outbox recovery owner may only be set by guarded offline-sale reauthorization",
		);
	}
	if (
		options.preserveLegacyUnscoped &&
		!hasRecordedInvoiceOutboxOwnerScope(payload)
	) {
		return entry;
	}

	const scope = hasRecordedInvoiceOutboxOwnerScope(payload)
		? getInvoiceOutboxOwnerScopeFromEntry(payload)
		: resolveInvoiceOutboxOwnerScope({
			pos_profile:
				payload?.invoice?.pos_profile || payload?.data?.pos_profile,
			company: payload?.invoice?.company || payload?.data?.company,
		});

	return {
		...entry,
		owner_scope_version: OWNER_SCOPE_VERSION,
		...scope,
	};
}

function isLegacyUnscopedInvoiceOutboxEntry(entry: AnyRecord = {}) {
	const payload = getEntryPayload(entry);
	return (
		!hasInvoiceOutboxOfflineSaleAuthorization(payload) &&
		!Object.prototype.hasOwnProperty.call(payload, "recovery_owner_user") &&
		!hasRecordedInvoiceOutboxOwnerScope(payload)
	);
}

function isMatchingInvoiceOutboxOwnerScope(
	entry: AnyRecord,
	activeScope: Required<InvoiceOutboxOwnerScope>,
) {
	if (isLegacyUnscopedInvoiceOutboxEntry(entry)) {
		// Rows created before owner routing did not retain enough information to
		// reconstruct a reliable scope. Preserve their established recovery path.
		return true;
	}
	const rowScope = getInvoiceOutboxEffectiveReplayScope(entry);
	if (
		!rowScope.owner_user ||
		!rowScope.pos_profile ||
		!rowScope.company ||
		!activeScope.owner_user ||
		!activeScope.pos_profile ||
		!activeScope.company
	) {
		// New rows must never silently fall back to an incomplete browser/session
		// context. They remain durable and wait until the original scope is known.
		return false;
	}
	return (
		rowScope.owner_user === activeScope.owner_user &&
		rowScope.pos_profile === activeScope.pos_profile &&
		rowScope.company === activeScope.company
	);
}

/**
 * Public display/recovery guard shared by the sync coordinator and terminal
 * UI. A scoped row is visible in full only to its effective cashier, POS
 * Profile, and company. Legacy unsigned rows retain their established path.
 */
export function isInvoiceOutboxOwnedByScope(
	entry: AnyRecord,
	activeScope: InvoiceOutboxOwnerScope = {},
) {
	return isMatchingInvoiceOutboxOwnerScope(
		entry,
		resolveInvoiceOutboxOwnerScope(activeScope),
	);
}

function haveMatchingInvoiceOutboxOwnerScope(
	left: AnyRecord,
	right: AnyRecord,
) {
	if (
		isLegacyUnscopedInvoiceOutboxEntry(left) ||
		isLegacyUnscopedInvoiceOutboxEntry(right)
	) {
		return true;
	}
	const leftScope = getInvoiceOutboxOwnerScopeFromEntry(left);
	const rightScope = getInvoiceOutboxOwnerScopeFromEntry(right);
	return (
		leftScope.owner_user === rightScope.owner_user &&
		leftScope.pos_profile === rightScope.pos_profile &&
		leftScope.company === rightScope.company
	);
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

function isManualBackofficeRecoveryAction(value: unknown) {
	return value === "manual_backoffice_review";
}

function getDisplaySafeOutboxError(entry: InvoiceOutboxEntry) {
	if (!hasInvoiceOutboxOfflineSaleAuthorization(entry)) {
		return entry.last_error;
	}
	if (isManualBackofficeRecoveryAction(entry.recovery_action)) {
		return OFFLINE_CASH_SALE_MANUAL_REVIEW_ERROR;
	}
	if (entry.status === "requires_reauthorization") {
		return getResolutionMessage("requires_reauthorization");
	}
	if (entry.status === "requires_supervisor_review") {
		return getResolutionMessage("requires_supervisor_review");
	}
	if (entry.status === "dead_letter") {
		return OFFLINE_CASH_SALE_MANUAL_REVIEW_ERROR;
	}
	if (entry.status === "waiting_owner") {
		return "Waiting for the matching cashier, POS profile, and company session before automatic sync.";
	}
	return OFFLINE_CASH_SALE_RETRY_ERROR;
}

function getOutboxFailureMessage(row: InvoiceOutboxEntry, error: unknown) {
	// Network libraries and Frappe diagnostics can echo request arguments. A
	// ticketed row must therefore never persist a generic exception string: it
	// may contain the bearer supplied to the sync endpoint.
	return hasInvoiceOutboxOfflineSaleAuthorization(row)
		? OFFLINE_CASH_SALE_RETRY_ERROR
		: toErrorMessage(error);
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

function getInvoiceIntentFingerprint(
	entry: AnyRecord,
	options: { includeOfflineSaleAuthorization?: boolean } = {},
) {
	const payload = entry?.payload || entry || {};
	const intent = {
		invoice: payload?.invoice || {},
		data: payload?.data || {},
	};
	if (options.includeOfflineSaleAuthorization !== false) {
		Object.assign(intent, {
			offline_sale_authorization:
				payload?.offline_sale_authorization || null,
		});
	}
	return stableStringify(intent);
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
	const cleanEntry = attachInvoiceOutboxOwnerScope(cloneSerializable(entry));
	if (cleanEntry?.offline_sale_authorization) {
		throw new Error(
			"Offline cash-sale authorizations must be stored in the durable invoice outbox, not the browser recovery journal",
		);
	}
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
			await enqueueInvoiceOutboxEntry(entry, {
				// Historical journals did not carry routing metadata. Do not bind an
				// old sale to whichever cashier happens to open the browser later.
				preserveLegacyUnscoped:
					!hasRecordedInvoiceOutboxOwnerScope(entry),
			});
		} catch (error) {
			console.error("Failed to restore invoice recovery journal entry", {
				clientRequestId: getInvoiceClientRequestId(entry),
				error: toErrorMessage(error),
			});
		}
	}
}

export async function enqueueInvoiceOutboxEntry(
	entry: AnyRecord,
	options: { preserveLegacyUnscoped?: boolean } = {},
) {
	const cleanEntry = attachInvoiceOutboxOwnerScope(cloneSerializable(entry), options);
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
			if (!haveMatchingInvoiceOutboxOwnerScope(existing, cleanEntry)) {
				throw new Error(
					`Invoice outbox owner scope collision for ${clientRequestId}; the saved owner, POS profile, and company are immutable`,
				);
			}
			return existing;
		}

		const timestamp = nowIso();
		const ownerScopeFields = hasRecordedInvoiceOutboxOwnerScope(cleanEntry)
			? {
					owner_scope_version: OWNER_SCOPE_VERSION,
					owner_user: cleanEntry.owner_user || null,
					pos_profile: cleanEntry.pos_profile || null,
					company: cleanEntry.company || null,
				}
			: {};
		const outboxEntry: InvoiceOutboxEntry = {
			client_request_id: clientRequestId,
			resource: "invoice_outbox",
			status: "pending",
			invoice: cleanEntry.invoice,
			data: cleanEntry.data || {},
			...ownerScopeFields,
			offline_sale_authorization:
				cleanEntry.offline_sale_authorization || null,
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
				// A ticketed offline cash sale is an immutable signed command. A
				// later customer rename must not mutate its outbox payload or break
				// the server-recorded authorization hash on reconnect.
				Boolean(String(row.offline_sale_authorization || "").trim()) ||
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
			await enqueueInvoiceOutboxEntry(payload, {
				// The compatibility queue predates owner routing unless its payload
				// explicitly carries the immutable metadata written by this build.
				preserveLegacyUnscoped:
					!hasRecordedInvoiceOutboxOwnerScope(payload),
			});
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

function redactInvoiceOutboxEntry(
	entry: InvoiceOutboxEntry,
): RedactedInvoiceOutboxEntry {
	const hasAuthorization = hasInvoiceOutboxOfflineSaleAuthorization(entry);
	const { offline_sale_authorization: _authorization, ...safeEntry } =
		cloneSerializable(entry);
	return {
		...safeEntry,
		last_error: getDisplaySafeOutboxError(entry),
		offline_sale_authorization: null,
		has_offline_sale_authorization: hasAuthorization,
	};
}

type InvoiceOutboxRowsForOptions<T extends GetInvoiceOutboxRowsOptions> =
	T extends { redactOfflineSaleAuthorization: true }
		? RedactedInvoiceOutboxEntry[]
		: InvoiceOutboxEntry[];

export async function getInvoiceOutboxRows<
	T extends GetInvoiceOutboxRowsOptions = GetInvoiceOutboxRowsOptions,
>(options: T = {} as T): Promise<InvoiceOutboxRowsForOptions<T>> {
	await ensureOutboxReady();
	const rows = (await db
		.table(TABLE)
		.orderBy("created_at")
		.toArray()) as InvoiceOutboxEntry[];
	const visibleRows = rows.filter(
		(row) => options.includeTerminal || !RESOLVED_STATUSES.has(row.status),
	);
	return (options.redactOfflineSaleAuthorization
		? visibleRows.map(redactInvoiceOutboxEntry)
		: visibleRows) as InvoiceOutboxRowsForOptions<T>;
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
	if (haveMatchingInvoiceOutboxIntent(storedEntry, expectedEntry)) {
		return;
	}

	const storedPayload = storedEntry?.payload || storedEntry || {};
	const expectedPayload = expectedEntry?.payload || expectedEntry || {};
	const isAcknowledgedEntryWithRedactedBearer =
		storedEntry?.status === "acknowledged" &&
		!storedPayload.offline_sale_authorization &&
		Boolean(expectedPayload.offline_sale_authorization) &&
		getInvoiceIntentFingerprint(storedEntry, {
			includeOfflineSaleAuthorization: false,
		}) ===
			getInvoiceIntentFingerprint(expectedEntry, {
				includeOfflineSaleAuthorization: false,
			});

	// A terminal acknowledgement deliberately erases the browser bearer. A retry
	// of that exact finalization still needs to be idempotent, but only after the
	// request identity, document type, invoice data, and server acknowledgement
	// have all been checked above/below.
	if (!isAcknowledgedEntryWithRedactedBearer) {
		throw new Error(
			`${operation} payload changed before completion; supervisor review is required`,
		);
	}
}

/**
 * Reauthorization is the only permitted mutation of a paused signed sale. The
 * new bearer deliberately differs, while the invoice, data, request identity,
 * and cashier/profile/company routing stay byte-for-byte equivalent.
 */
function assertMatchingInvoiceIntentForAuthorizationReplacement(
	storedEntry: AnyRecord,
	expectedEntry: AnyRecord,
	clientRequestId: string,
) {
	const operation = "Offline cash-sale reauthorization";
	const expectedPayload = getEntryPayload(expectedEntry);
	if (
		String(expectedPayload?.offline_sale_authorization || "").trim()
	) {
		throw new Error(
			`${operation} requires a redacted recovery row; authorization must not enter UI state`,
		);
	}
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
		throw new Error(`${operation} document type changed before replacement`);
	}
	const expectedStatus = String(expectedPayload?.status || "").trim();
	if (!ACTION_REQUIRED_STATUSES.has(expectedStatus as InvoiceOutboxStatus)) {
		throw new Error(`${operation} expected row is not paused`);
	}
	if (storedEntry?.status !== expectedStatus) {
		throw new Error(`${operation} status changed before replacement`);
	}
	const expectedOutboxId = Number(expectedPayload?.outbox_id);
	const storedOutboxId = Number(storedEntry?.outbox_id);
	if (
		!Number.isFinite(expectedOutboxId) ||
		!Number.isFinite(storedOutboxId) ||
		expectedOutboxId !== storedOutboxId
	) {
		throw new Error(`${operation} outbox row changed before replacement`);
	}
	if (
		getInvoiceIntentFingerprint(storedEntry, {
			includeOfflineSaleAuthorization: false,
		}) !==
			getInvoiceIntentFingerprint(expectedEntry, {
				includeOfflineSaleAuthorization: false,
			})
	) {
		throw new Error(
			`${operation} invoice or data changed before replacement; supervisor review is required`,
		);
	}

	const storedHasOwnerScope = hasRecordedInvoiceOutboxOwnerScope(storedEntry);
	const expectedHasOwnerScope = hasRecordedInvoiceOutboxOwnerScope(expectedEntry);
	if (
		storedHasOwnerScope !== expectedHasOwnerScope ||
		!haveMatchingInvoiceOutboxOwnerScope(storedEntry, expectedEntry)
	) {
		throw new Error(
			`${operation} owner, POS profile, or company changed before replacement`,
		);
	}
	if (
		normalizeOwnerScopeValue(storedEntry?.recovery_owner_user) !==
		normalizeOwnerScopeValue(expectedPayload?.recovery_owner_user)
	) {
		throw new Error(`${operation} recovery owner changed before replacement`);
	}
	return storedDocumentType;
}

function assertCurrentRecoveryOwner(
	current: InvoiceOutboxEntry,
	recoveryOwnerUser: string,
) {
	const recoveryOwner = normalizeOwnerScopeValue(recoveryOwnerUser);
	const activeScope = resolveInvoiceOutboxOwnerScope();
	const originalScope = getInvoiceOutboxOwnerScopeFromEntry(current);
	if (!recoveryOwner || activeScope.owner_user !== recoveryOwner) {
		throw new Error(
			"Offline cash-sale reauthorization owner must match the authenticated browser user",
		);
	}
	if (
		!originalScope.pos_profile ||
		!originalScope.company ||
		activeScope.pos_profile !== originalScope.pos_profile ||
		activeScope.company !== originalScope.company
	) {
		throw new Error(
			"Offline cash-sale reauthorization must retain the original POS profile and company scope",
		);
	}
	return recoveryOwner;
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

/**
 * Reads the exact durable command for one immediate online PIN check. The
 * caller must present the display-safe row it rendered; a mismatch fails
 * closed rather than exposing a bearer for a different sale.
 */
export async function getInvoiceOutboxReauthorizationCommand(
	clientRequestId: string,
	expectedRedactedEntry: AnyRecord,
): Promise<InvoiceOutboxReauthorizationCommand> {
	const normalizedId = String(clientRequestId || "").trim();
	if (!normalizedId) {
		throw new Error(
			"Offline cash-sale reauthorization requires a client request ID",
		);
	}
	assertSupportedInvoiceOutboxEntry(
		expectedRedactedEntry,
		"Offline cash-sale reauthorization",
	);
	await ensureOutboxReady();
	const table = db.table(TABLE);

	return db.transaction("r", table, async () => {
		const current = (await table
			.where("client_request_id")
			.equals(normalizedId)
			.first()) as InvoiceOutboxEntry | undefined;
		if (!current) {
			throw new Error(
				`Offline cash-sale reauthorization could not find ${normalizedId}`,
			);
		}
		if (!ACTION_REQUIRED_STATUSES.has(current.status)) {
			throw new Error(
				`Offline cash-sale reauthorization requires a paused authorization row; found ${current.status}`,
			);
		}
		const documentType =
			assertMatchingInvoiceIntentForAuthorizationReplacement(
				current,
				expectedRedactedEntry,
				normalizedId,
			);
		const authorization = String(
			current.offline_sale_authorization || "",
		).trim();
		if (!authorization) {
			throw new Error(
				"Offline cash-sale reauthorization found no durable authorization to use",
			);
		}

		return {
			client_request_id: normalizedId,
			document_type: documentType,
			invoice: cloneSerializable(current.invoice),
			data: cloneSerializable(current.data),
			offline_sale_authorization: authorization,
		};
	});
}

/**
 * Installs a freshly PIN-authorized bearer for one paused offline cash sale.
 * The caller supplies the redacted row it rendered and the prior bearer from a
 * transient command. This function always retains the current durable
 * invoice/data/routing fields rather than accepting a caller-provided payload.
 */
export async function replaceInvoiceOutboxOfflineSaleAuthorization(
	clientRequestId: string,
	expectedRedactedEntry: AnyRecord,
	previousAuthorization: string,
	freshAuthorization: string,
	recoveryOwnerUser: string,
) {
	const normalizedId = String(clientRequestId || "").trim();
	const previous = String(previousAuthorization || "").trim();
	const authorization = String(freshAuthorization || "").trim();
	const requestedRecoveryOwner = normalizeOwnerScopeValue(recoveryOwnerUser);
	if (!normalizedId) {
		throw new Error(
			"Offline cash-sale reauthorization requires a client request ID",
		);
	}
	if (!authorization) {
		throw new Error(
			"Offline cash-sale reauthorization requires a fresh authorization",
		);
	}
	if (!previous) {
		throw new Error(
			"Offline cash-sale reauthorization requires the current authorization",
		);
	}
	if (!requestedRecoveryOwner) {
		throw new Error(
			"Offline cash-sale reauthorization requires the fresh ticket owner",
		);
	}
	assertSupportedInvoiceOutboxEntry(
		expectedRedactedEntry,
		"Offline cash-sale reauthorization",
	);
	await ensureOutboxReady();
	const table = db.table(TABLE);

	return db.transaction("rw", table, async () => {
		const current = (await table
			.where("client_request_id")
			.equals(normalizedId)
			.first()) as InvoiceOutboxEntry | undefined;
		if (!current) {
			throw new Error(
				`Offline cash-sale reauthorization could not find ${normalizedId}`,
			);
		}
		if (!ACTION_REQUIRED_STATUSES.has(current.status)) {
			throw new Error(
				`Offline cash-sale reauthorization requires a paused authorization row; found ${current.status}`,
			);
		}
		assertMatchingInvoiceIntentForAuthorizationReplacement(
			current,
			expectedRedactedEntry,
			normalizedId,
		);
		const recoveryOwner = assertCurrentRecoveryOwner(
			current,
			requestedRecoveryOwner,
		);

		const currentAuthorization = String(
			current.offline_sale_authorization || "",
		).trim();
		if (!currentAuthorization) {
			throw new Error(
				"Offline cash-sale reauthorization found no durable authorization to replace",
			);
		}
		if (previous !== currentAuthorization) {
			throw new Error(
				"Offline cash-sale reauthorization authorization changed before replacement",
			);
		}
		if (currentAuthorization === authorization) {
			throw new Error(
				"Offline cash-sale reauthorization requires a newly issued authorization",
			);
		}

		const replacement: InvoiceOutboxEntry = {
			...current,
			// Only the one-time bearer and recovery bookkeeping change. Invoice,
			// data, request identity, and original owner scope remain from IndexedDB.
			offline_sale_authorization: authorization,
			recovery_owner_user: recoveryOwner,
			recovery_action: null,
			status: "pending",
			updated_at: nowIso(),
			next_retry_at: null,
			nextAttemptAt: null,
			retry_count: 0,
			last_error: null,
			sync_attempt_id: null,
		};
		await table.put(replacement);
		return replacement;
	});
}

/**
 * Converts an already-paused ticketed sale into a durable manual-review state
 * after the server says that current policy cannot issue any replacement. This
 * changes no invoice data, authorization, owner provenance, or request ID;
 * it only prevents the terminal from prompting for PINs that cannot help.
 */
export async function markInvoiceOutboxManualBackofficeReview(
	clientRequestId: string,
	expectedRedactedEntry: AnyRecord,
) {
	const normalizedId = String(clientRequestId || "").trim();
	if (!normalizedId) {
		throw new Error(
			"Offline cash-sale manual review requires a client request ID",
		);
	}
	assertSupportedInvoiceOutboxEntry(
		expectedRedactedEntry,
		"Offline cash-sale manual review",
	);
	await ensureOutboxReady();
	const table = db.table(TABLE);

	return db.transaction("rw", table, async () => {
		const current = (await table
			.where("client_request_id")
			.equals(normalizedId)
			.first()) as InvoiceOutboxEntry | undefined;
		if (!current) {
			throw new Error(
				`Offline cash-sale manual review could not find ${normalizedId}`,
			);
		}
		if (!ACTION_REQUIRED_STATUSES.has(current.status)) {
			throw new Error(
				`Offline cash-sale manual review requires a paused authorization row; found ${current.status}`,
			);
		}
		assertMatchingInvoiceIntentForAuthorizationReplacement(
			current,
			expectedRedactedEntry,
			normalizedId,
		);
		if (!hasInvoiceOutboxOfflineSaleAuthorization(current)) {
			throw new Error(
				"Offline cash-sale manual review requires a durable authorization row",
			);
		}

		const updated: InvoiceOutboxEntry = {
			...current,
			status: "requires_supervisor_review",
			recovery_action: "manual_backoffice_review",
			updated_at: nowIso(),
			next_retry_at: null,
			nextAttemptAt: null,
			last_error: OFFLINE_CASH_SALE_MANUAL_REVIEW_ERROR,
			sync_attempt_id: null,
		};
		await table.put(updated);
		return updated;
	});
}

function shouldAttempt(row: InvoiceOutboxEntry) {
	if (TERMINAL_STATUSES.has(row.status)) return false;
	if (ACTION_REQUIRED_STATUSES.has(row.status)) return false;
	if (row.status === "waiting_owner") return false;
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
		// The server has now persisted a non-secret audit record and acknowledged
		// this exact request. Retained terminal rows must not keep its bearer.
		offline_sale_authorization: null,
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
	const ticketedCashSale = hasInvoiceOutboxOfflineSaleAuthorization(row);
	return {
		...row,
		resource: "invoice_outbox" as const,
		status: "dead_letter",
		updated_at: nowIso(),
		next_retry_at: null,
		nextAttemptAt: null,
		last_error: ticketedCashSale
			? OFFLINE_CASH_SALE_MANUAL_REVIEW_ERROR
			: error === undefined
				? `Automatic recovery is not supported for ${documentType}; supervisor review is required`
				: toErrorMessage(error),
		sync_attempt_id: null,
	};
}

function markOutboxWaitingForOwner(
	row: InvoiceOutboxEntry,
): InvoiceOutboxEntry {
	return {
		...row,
		resource: "invoice_outbox" as const,
		status: "waiting_owner",
		updated_at: nowIso(),
		next_retry_at: null,
		nextAttemptAt: null,
		last_error:
			"Waiting for the matching cashier, POS profile, and company session before automatic sync.",
		sync_attempt_id: null,
	};
}

function getResolutionMessage(
	resolution: InvoiceOutboxResolution,
	recoveryAction: InvoiceOutboxRecoveryAction | null = null,
) {
	if (isManualBackofficeRecoveryAction(recoveryAction)) {
		return OFFLINE_CASH_SALE_MANUAL_REVIEW_ERROR;
	}
	return resolution === "requires_reauthorization"
		? "Offline cash-sale authorization must be refreshed with a cashier PIN before this exact sale can sync."
		: "Offline cash sale requires supervisor authorization before this exact sale can sync.";
}

function markOutboxActionRequired(
	row: InvoiceOutboxEntry,
	resolution: InvoiceOutboxResolution,
	recoveryAction: InvoiceOutboxRecoveryAction | null = null,
): InvoiceOutboxEntry {
	return {
		...row,
		resource: "invoice_outbox" as const,
		status: resolution,
		recovery_action: recoveryAction,
		updated_at: nowIso(),
		next_retry_at: null,
		nextAttemptAt: null,
		// Do not persist an arbitrary server response here: this value is shown
		// in recovery UI and must never echo an authorization bearer or traceback.
		last_error: getResolutionMessage(resolution, recoveryAction),
		sync_attempt_id: null,
	};
}

function resumeOutboxWaitingForOwner(
	row: InvoiceOutboxEntry,
): InvoiceOutboxEntry {
	return {
		...row,
		resource: "invoice_outbox" as const,
		status: "pending",
		updated_at: nowIso(),
		next_retry_at: null,
		nextAttemptAt: null,
		last_error: null,
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

type TypedOutboxResolution = {
	resolution: InvoiceOutboxResolution;
	recoveryAction: InvoiceOutboxRecoveryAction | null;
};

function getTypedOutboxResolution(
	row: InvoiceOutboxEntry,
	response: AnyRecord,
): TypedOutboxResolution | null {
	const resolution = String(response?.resolution || "").trim();
	if (
		response?.acknowledged !== false ||
		response?.definitive_rejection !== true ||
		!INVOICE_OUTBOX_RESOLUTION_SET.has(
			resolution as InvoiceOutboxResolution,
		) ||
		String(response?.client_request_id || "").trim() !==
			row.client_request_id ||
		!String(row.offline_sale_authorization || "").trim()
	) {
		return null;
	}
	const recoveryAction =
		resolution === "requires_supervisor_review" &&
		MANUAL_BACKOFFICE_REASON_SET.has(String(response?.reason || "").trim())
			? "manual_backoffice_review"
			: null;
	return {
		resolution: resolution as InvoiceOutboxResolution,
		recoveryAction,
	};
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
		last_error: getOutboxFailureMessage(row, error),
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
	requiresReauthorizationCount: number;
	requiresSupervisorReviewCount: number;
	waitingOwnerCount: number;
}

let invoiceOutboxSyncPromise: Promise<InvoiceOutboxSyncResult> | null = null;

async function claimInvoiceOutboxRows(
	activeScope: Required<InvoiceOutboxOwnerScope>,
) {
	const table = db.table(TABLE);
	const claimedRows: InvoiceOutboxEntry[] = [];
	await db.transaction("rw", table, async () => {
		const rows = ((await table.toArray()) as InvoiceOutboxEntry[]).sort(
			(left, right) => left.created_at.localeCompare(right.created_at),
		);
		for (let current of rows) {
			if (current.status === "acknowledged") continue;
			try {
				assertStoredInvoiceOutboxIntegrity(current);
			} catch (error) {
				if (current.status !== "dead_letter") {
					await table.put(markOutboxUnsupported(current, error));
				}
				continue;
			}
			if (TERMINAL_STATUSES.has(current.status)) continue;
			// A typed authorization outcome is deliberately sticky. A different
			// cashier opening this terminal must not overwrite the actionable reason
			// with a generic owner-waiting state.
			if (ACTION_REQUIRED_STATUSES.has(current.status)) continue;
			if (!isMatchingInvoiceOutboxOwnerScope(current, activeScope)) {
				if (current.status !== "waiting_owner") {
					await table.put(markOutboxWaitingForOwner(current));
				}
				continue;
			}
			if (current.status === "waiting_owner") {
				current = resumeOutboxWaitingForOwner(current);
				await table.put(current);
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
	| InvoiceOutboxResolution
	| "already_acknowledged"
	| "stale";

async function completeInvoiceOutboxClaim(
	claimed: InvoiceOutboxEntry,
	completion:
		| { kind: "acknowledged"; response: AnyRecord }
		| {
					kind: "action_required";
					resolution: InvoiceOutboxResolution;
					recoveryAction?: InvoiceOutboxRecoveryAction | null;
			  }
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
		if (completion.kind === "action_required") {
			await table.put(
				markOutboxActionRequired(
					current,
					completion.resolution,
					completion.recoveryAction || null,
				),
			);
			return completion.resolution;
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
	activeOwnerScope: Required<InvoiceOutboxOwnerScope>,
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
	const claimedRows = await claimInvoiceOutboxRows(activeOwnerScope);

	for (const claimed of claimedRows) {
		let response: AnyRecord;
		try {
			response = await callOfflineSyncMethod(
				"posawesome.posawesome.api.offline_sync.invoices.submit_invoice_outbox_entry",
				{
					client_request_id: claimed.client_request_id,
					invoice: claimed.invoice,
					data: claimed.data,
					offline_sale_authorization:
						claimed.offline_sale_authorization || undefined,
				},
			);
			const resolution = getTypedOutboxResolution(claimed, response || {});
			if (resolution) {
				await completeInvoiceOutboxClaim(claimed, {
					kind: "action_required",
					resolution: resolution.resolution,
					recoveryAction: resolution.recoveryAction,
				});
				continue;
			}
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
	const waitingOwnerRows = unresolvedRows.filter(
		(row) => row.status === "waiting_owner",
	);
	const reauthorizationRows = unresolvedRows.filter(
		(row) => row.status === "requires_reauthorization",
	);
	const supervisorReviewRows = unresolvedRows.filter(
		(row) => row.status === "requires_supervisor_review",
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
			: supervisorReviewRows.length
				? `${supervisorReviewRows.length} offline cash sale${supervisorReviewRows.length === 1 ? " requires" : "s require"} supervisor authorization before sync`
				: reauthorizationRows.length
					? `${reauthorizationRows.length} offline cash sale${reauthorizationRows.length === 1 ? " requires" : "s require"} cashier reauthorization before sync`
			: waitingOwnerRows.length
				? `${waitingOwnerRows.length} invoice outbox entr${waitingOwnerRows.length === 1 ? "y is" : "ies are"} waiting for its owner session`
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
		requiresReauthorizationCount: reauthorizationRows.length,
		requiresSupervisorReviewCount: supervisorReviewRows.length,
		waitingOwnerCount: waitingOwnerRows.length,
	};
}

export function syncInvoiceOutboxResource(
	callOfflineSyncMethod: (
		method: string,
		args?: Record<string, any>,
	) => Promise<any>,
	activeOwnerScope: InvoiceOutboxOwnerScope = {},
) {
	if (invoiceOutboxSyncPromise) {
		return invoiceOutboxSyncPromise;
	}

	invoiceOutboxSyncPromise = executeInvoiceOutboxSync(
		callOfflineSyncMethod,
		resolveInvoiceOutboxOwnerScope(activeOwnerScope),
	).finally(() => {
		invoiceOutboxSyncPromise = null;
	});
	return invoiceOutboxSyncPromise;
}

registerPostHydrationTask(recoverInvoiceIntentJournal);
