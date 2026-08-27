export interface ActiveInvoiceSubmissionRecovery {
	requestId: string;
	invoiceName: string | null;
	documentType: string | null;
	recoveryMode: "invoice_outbox" | "manual_only";
	posProfile: string | null;
	company: string | null;
	user: string | null;
	cartFingerprint: string | null;
	printRequested: boolean;
	startedAt: string;
}

const ACTIVE_RECOVERY_KEY = "posa_active_invoice_submission_recovery_v1";
const CLIENT_EFFECTS_KEY_PREFIX = "posa_invoice_recovery_client_effects_v1::";

let memoryActiveRecovery: ActiveInvoiceSubmissionRecovery | null = null;
const memoryClientEffects = new Set<string>();

function normalizeRequestId(value: unknown) {
	return String(value || "").trim();
}

function normalizeFingerprintNumber(value: unknown) {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function normalizeFingerprintFlag(value: unknown) {
	return value === true || value === 1 || value === "1" ? 1 : 0;
}

function resolveFingerprintItems(doc: any, cartItems: any[] = []) {
	const documentItems = Array.isArray(doc?.items) ? doc.items : [];
	return documentItems.length
		? documentItems
		: Array.isArray(cartItems)
			? cartItems
			: [];
}

/**
 * Builds a deterministic semantic identity for the tender that owns a recovery
 * pointer. It intentionally excludes server timestamps and other volatile
 * metadata while retaining the document, item, and payment values that could
 * make clearing a newer cart unsafe.
 */
export function buildInvoiceRecoveryCartFingerprint(
	doc: any,
	cartItems: any[] = [],
) {
	const items = resolveFingerprintItems(doc, cartItems).map((item: any) => ({
		rowId: normalizeRequestId(item?.posa_row_id),
		itemCode: normalizeRequestId(item?.item_code),
		warehouse: normalizeRequestId(item?.warehouse),
		batchNo: normalizeRequestId(item?.batch_no),
		serialNo: normalizeRequestId(item?.serial_no),
		uom: normalizeRequestId(item?.uom),
		stockUom: normalizeRequestId(item?.stock_uom),
		qty: normalizeFingerprintNumber(item?.qty),
		stockQty: normalizeFingerprintNumber(item?.stock_qty),
		rate: normalizeFingerprintNumber(item?.rate),
		priceListRate: normalizeFingerprintNumber(item?.price_list_rate),
		amount: normalizeFingerprintNumber(item?.amount),
		discountAmount: normalizeFingerprintNumber(item?.discount_amount),
		discountPercentage: normalizeFingerprintNumber(
			item?.discount_percentage,
		),
	}));
	const payments = (Array.isArray(doc?.payments) ? doc.payments : []).map(
		(payment: any) => ({
			modeOfPayment: normalizeRequestId(payment?.mode_of_payment),
			account: normalizeRequestId(payment?.account),
			type: normalizeRequestId(payment?.type),
			amount: normalizeFingerprintNumber(payment?.amount),
			baseAmount: normalizeFingerprintNumber(payment?.base_amount),
		}),
	);

	return JSON.stringify({
		version: 1,
		document: {
			name: normalizeRequestId(doc?.name),
			doctype: normalizeRequestId(doc?.doctype),
			company: normalizeRequestId(doc?.company),
			posProfile: normalizeRequestId(doc?.pos_profile),
			customer: normalizeRequestId(doc?.customer),
			currency: normalizeRequestId(doc?.currency),
			isReturn: normalizeFingerprintFlag(doc?.is_return),
			returnAgainst: normalizeRequestId(doc?.return_against),
			grandTotal: normalizeFingerprintNumber(doc?.grand_total),
			roundedTotal: normalizeFingerprintNumber(doc?.rounded_total),
			total: normalizeFingerprintNumber(doc?.total),
			netTotal: normalizeFingerprintNumber(doc?.net_total),
			paidChange: normalizeFingerprintNumber(doc?.paid_change),
			creditChange: normalizeFingerprintNumber(doc?.credit_change),
			writeOffAmount: normalizeFingerprintNumber(doc?.write_off_amount),
			loyaltyAmount: normalizeFingerprintNumber(doc?.loyalty_amount),
			loyaltyPoints: normalizeFingerprintNumber(doc?.loyalty_points),
			additionalDiscountPercentage: normalizeFingerprintNumber(
				doc?.additional_discount_percentage,
			),
			discountAmount: normalizeFingerprintNumber(doc?.discount_amount),
		},
		items,
		payments,
	});
}

export function isSemanticallyEmptyInvoiceRecoveryCart(
	doc: any,
	cartItems: any[] = [],
) {
	const items = resolveFingerprintItems(doc, cartItems);
	if (items.length || normalizeRequestId(doc?.name)) {
		return false;
	}
	if (normalizeRequestId(doc?.posa_client_request_id)) {
		return false;
	}
	const totals = [
		doc?.grand_total,
		doc?.rounded_total,
		doc?.total,
		doc?.net_total,
	];
	if (totals.some((value) => Math.abs(Number(value || 0)) > 0.000001)) {
		return false;
	}
	return !(Array.isArray(doc?.payments)
		? doc.payments.some(
				(payment: any) =>
					Math.abs(Number(payment?.amount || 0)) > 0.000001,
			)
		: false);
}

function getStorage() {
	try {
		return typeof localStorage !== "undefined" ? localStorage : null;
	} catch {
		return null;
	}
}

function clientEffectsKey(requestId: string) {
	return `${CLIENT_EFFECTS_KEY_PREFIX}${encodeURIComponent(requestId)}`;
}

function createPersistenceError(operation: string, cause?: unknown) {
	const error = new Error(
		`Unable to durably ${operation} invoice recovery state`,
	);
	(error as any).code = "POSA_RECOVERY_PERSISTENCE_FAILED";
	(error as any).cause = cause;
	return error;
}

function createActiveRecoveryConflictError(
	activeRequestId: string,
	requestedRequestId: string,
) {
	const error = new Error(
		"Another POS tab or restored sale already owns invoice submission recovery. Resolve it before starting a new submission.",
	);
	(error as any).code = "POSA_ACTIVE_RECOVERY_CONFLICT";
	(error as any).activeRequestId = activeRequestId;
	(error as any).requestedRequestId = requestedRequestId;
	return error;
}

function persistAndVerify(key: string, serialized: string, operation: string) {
	const storage = getStorage();
	if (!storage) {
		throw createPersistenceError(operation);
	}
	try {
		storage.setItem(key, serialized);
		if (storage.getItem(key) !== serialized) {
			throw new Error("Recovery state read-back did not match");
		}
	} catch (error) {
		throw createPersistenceError(operation, error);
	}
}

export function persistActiveInvoiceSubmissionRecovery(
	recovery: Omit<
		ActiveInvoiceSubmissionRecovery,
		| "startedAt"
		| "documentType"
		| "recoveryMode"
		| "posProfile"
		| "company"
		| "user"
		| "cartFingerprint"
	> & {
		startedAt?: string;
		documentType?: string | null;
		recoveryMode?: "invoice_outbox" | "manual_only";
		posProfile?: string | null;
		company?: string | null;
		user?: string | null;
		cartFingerprint?: string | null;
	},
) {
	const requestId = normalizeRequestId(recovery?.requestId);
	if (!requestId) {
		throw new Error("Active invoice recovery requires a request ID");
	}
	const activeRecovery = getActiveInvoiceSubmissionRecovery();
	if (activeRecovery?.requestId && activeRecovery.requestId !== requestId) {
		// localStorage is shared by every same-origin tab. Never overwrite the
		// unresolved write-ahead pointer belonging to another cart/tab; doing so
		// would make the first ambiguous submission undiscoverable after reload.
		throw createActiveRecoveryConflictError(
			activeRecovery.requestId,
			requestId,
		);
	}
	const normalized: ActiveInvoiceSubmissionRecovery = {
		requestId,
		invoiceName: normalizeRequestId(recovery.invoiceName) || null,
		documentType: normalizeRequestId(recovery.documentType) || null,
		recoveryMode:
			recovery.recoveryMode === "manual_only"
				? "manual_only"
				: "invoice_outbox",
		posProfile: normalizeRequestId(recovery.posProfile) || null,
		company: normalizeRequestId(recovery.company) || null,
		user: normalizeRequestId(recovery.user) || null,
		cartFingerprint: normalizeRequestId(recovery.cartFingerprint) || null,
		printRequested: Boolean(recovery.printRequested),
		startedAt: recovery.startedAt || new Date().toISOString(),
	};
	const serialized = JSON.stringify(normalized);
	// Do not expose an in-memory recovery lock unless its browser-persistent
	// counterpart has been written and verified. Callers deliberately fail
	// closed into manual review when this throws.
	persistAndVerify(ACTIVE_RECOVERY_KEY, serialized, "save the active");
	memoryActiveRecovery = normalized;
	return normalized;
}

export function getActiveInvoiceSubmissionRecovery() {
	try {
		const serialized = getStorage()?.getItem(ACTIVE_RECOVERY_KEY);
		if (serialized) {
			const parsed = JSON.parse(serialized);
			const requestId = normalizeRequestId(parsed?.requestId);
			if (requestId) {
				const documentType =
					normalizeRequestId(parsed?.documentType) || null;
				memoryActiveRecovery = {
					requestId,
					invoiceName:
						normalizeRequestId(parsed?.invoiceName) || null,
					documentType,
					recoveryMode:
						parsed?.recoveryMode === "manual_only" ||
						(documentType !== null &&
							!["Sales Invoice", "POS Invoice"].includes(
								documentType,
							))
							? "manual_only"
							: "invoice_outbox",
					posProfile: normalizeRequestId(parsed?.posProfile) || null,
					company: normalizeRequestId(parsed?.company) || null,
					user: normalizeRequestId(parsed?.user) || null,
					cartFingerprint:
						normalizeRequestId(parsed?.cartFingerprint) || null,
					printRequested: Boolean(parsed?.printRequested),
					startedAt:
						normalizeRequestId(parsed?.startedAt) ||
						new Date().toISOString(),
				};
			}
		}
	} catch (error) {
		console.warn("Ignoring invalid active invoice recovery pointer", error);
	}
	return memoryActiveRecovery ? { ...memoryActiveRecovery } : null;
}

export function clearActiveInvoiceSubmissionRecovery(requestId?: string) {
	const expectedRequestId = normalizeRequestId(requestId);
	const active = getActiveInvoiceSubmissionRecovery();
	if (
		expectedRequestId &&
		active?.requestId &&
		active.requestId !== expectedRequestId
	) {
		return false;
	}
	const storage = getStorage();
	if (!storage) {
		return false;
	}
	try {
		storage.removeItem(ACTIVE_RECOVERY_KEY);
		if (storage.getItem(ACTIVE_RECOVERY_KEY) !== null) {
			return false;
		}
	} catch (error) {
		console.warn("Unable to clear active invoice recovery pointer", error);
		return false;
	}
	memoryActiveRecovery = null;
	return true;
}

export function hasInvoiceRecoveryClientEffects(requestId: string) {
	const normalizedRequestId = normalizeRequestId(requestId);
	if (!normalizedRequestId) {
		return false;
	}
	if (memoryClientEffects.has(normalizedRequestId)) {
		return true;
	}
	try {
		if (getStorage()?.getItem(clientEffectsKey(normalizedRequestId))) {
			memoryClientEffects.add(normalizedRequestId);
			return true;
		}
	} catch (error) {
		console.warn("Unable to read invoice recovery effects marker", error);
	}
	return false;
}

/**
 * Claims irreversible client-side settlement effects before applying them.
 * Print, sound, stock-cache consumption, and success callbacks are at-most-once
 * across remounts; idempotent merge/navigation cleanup may safely repeat.
 */
export function claimInvoiceRecoveryClientEffects(requestId: string) {
	const normalizedRequestId = normalizeRequestId(requestId);
	if (
		!normalizedRequestId ||
		hasInvoiceRecoveryClientEffects(normalizedRequestId)
	) {
		return false;
	}
	persistAndVerify(
		clientEffectsKey(normalizedRequestId),
		JSON.stringify({ claimedAt: new Date().toISOString() }),
		"claim the client effects for this",
	);
	memoryClientEffects.add(normalizedRequestId);
	return true;
}

/**
 * Clears a client-effects claim only after the caller has durably removed the
 * active recovery pointer. A failed cleanup leaves the marker in place, which
 * is conservative and still prevents duplicate irreversible effects.
 */
export function clearInvoiceRecoveryClientEffects(requestId: string) {
	const normalizedRequestId = normalizeRequestId(requestId);
	if (!normalizedRequestId) {
		return false;
	}
	const storage = getStorage();
	if (!storage) {
		return false;
	}
	const key = clientEffectsKey(normalizedRequestId);
	try {
		storage.removeItem(key);
		if (storage.getItem(key) !== null) {
			return false;
		}
	} catch (error) {
		console.warn("Unable to clear invoice recovery effects marker", error);
		return false;
	}
	memoryClientEffects.delete(normalizedRequestId);
	return true;
}

export function resetInvoiceRecoveryMemoryForTests() {
	memoryActiveRecovery = null;
	memoryClientEffects.clear();
}

export function resetInvoiceRecoveryStateForTests() {
	const storage = getStorage();
	resetInvoiceRecoveryMemoryForTests();
	try {
		storage?.removeItem(ACTIVE_RECOVERY_KEY);
		if (storage) {
			for (let index = storage.length - 1; index >= 0; index -= 1) {
				const key = storage.key(index);
				if (key?.startsWith(CLIENT_EFFECTS_KEY_PREFIX)) {
					storage.removeItem(key);
				}
			}
		}
	} catch {
		// Test cleanup is best-effort in restricted storage environments.
	}
}
