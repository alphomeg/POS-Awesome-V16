import { db, startupInitPromise } from "./db";

export interface OfflineSaleAuthorizationScope {
	posProfile: string;
	company: string;
	user: string;
}

export interface OfflineCashSaleAuthorizationTicket {
	authorization: string;
	client_request_id: string;
	/** Authenticated browser user that received this server-signed ticket. */
	owner_user: string;
	expires_at: string;
	cashier: string;
	cash_mode_of_payment: string;
	maximum_amount: string;
	/** POS Profile company currency used for the signed maximum and settlement. */
	company_currency: string;
	document_type: "Sales Invoice" | "POS Invoice";
}

type StoredTicket = OfflineCashSaleAuthorizationTicket & {
	status: "available" | "reserved" | "consumed";
	reserved_at?: string | null;
	consumed_at?: string | null;
};

type StoredAuthorizationBatch = {
	v: 1;
	scope: OfflineSaleAuthorizationScope;
	/** The most recently PIN-verified cashier whose batch this terminal may use. */
	cashier: string | null;
	tickets: StoredTicket[];
};

const KEY_PREFIX = "posa_offline_cash_sale_authorizations:";
const MAX_STORED_TICKETS = 25;
const RESERVATION_LEASE_MS = 10 * 60 * 1_000;

function normalized(value: unknown) {
	return String(value || "").trim();
}

function normalizeScope(scope: OfflineSaleAuthorizationScope): OfflineSaleAuthorizationScope {
	const result = {
		posProfile: normalized(scope?.posProfile),
		company: normalized(scope?.company),
		user: normalized(scope?.user),
	};
	if (!result.posProfile || !result.company || !result.user) {
		throw new Error("Offline cash-sale authorization requires POS Profile, company, and user scope");
	}
	return result;
}

function storageKey(scope: OfflineSaleAuthorizationScope) {
	const normalizedScope = normalizeScope(scope);
	return `${KEY_PREFIX}${encodeURIComponent(normalizedScope.posProfile)}:${encodeURIComponent(normalizedScope.company)}:${encodeURIComponent(normalizedScope.user)}`;
}

function isUnexpired(ticket: Pick<OfflineCashSaleAuthorizationTicket, "expires_at">) {
	const expiry = Date.parse(String(ticket?.expires_at || ""));
	return Number.isFinite(expiry) && expiry > Date.now();
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

async function ensureReady() {
	if (!db.isOpen()) {
		await startupInitPromise;
	}
	if (!db.isOpen()) {
		await db.open();
	}
}

function normalizeTicket(value: any): OfflineCashSaleAuthorizationTicket | null {
	const ticket = {
		authorization: normalized(value?.authorization),
		client_request_id: normalized(value?.client_request_id),
		owner_user: normalized(value?.owner_user),
		expires_at: normalized(value?.expires_at),
		cashier: normalized(value?.cashier),
		cash_mode_of_payment: normalized(value?.cash_mode_of_payment),
		maximum_amount: normalized(value?.maximum_amount),
		company_currency: normalized(value?.company_currency),
		document_type: normalized(value?.document_type) as
			| "Sales Invoice"
			| "POS Invoice",
	};
	if (
		!ticket.authorization ||
		!ticket.client_request_id ||
		!ticket.owner_user ||
		!ticket.cashier ||
		!ticket.cash_mode_of_payment ||
		!ticket.maximum_amount ||
		!ticket.company_currency ||
		!["Sales Invoice", "POS Invoice"].includes(ticket.document_type) ||
		!isUnexpired(ticket)
	) {
		return null;
	}
	return ticket;
}

function normalizeStoredBatch(
	value: any,
	scope: OfflineSaleAuthorizationScope,
): StoredAuthorizationBatch {
	const normalizedScope = normalizeScope(scope);
	const candidates = Array.isArray(value?.tickets) ? value.tickets : [];
	const byRequestId = new Map<string, StoredTicket>();
	for (const candidate of candidates) {
		const ticket = normalizeTicket(candidate);
		if (!ticket || byRequestId.has(ticket.client_request_id)) continue;
		const status = ["available", "reserved", "consumed"].includes(candidate?.status)
			? candidate.status
			: "available";
		byRequestId.set(ticket.client_request_id, {
			...ticket,
			status,
			reserved_at: candidate?.reserved_at || null,
			consumed_at: candidate?.consumed_at || null,
		});
	}
	const tickets = Array.from(byRequestId.values())
		.filter((ticket) => ticket.owner_user === normalizedScope.user)
		.slice(-MAX_STORED_TICKETS);
	const configuredCashier = normalized(value?.cashier);
	const cashier =
		configuredCashier || tickets[tickets.length - 1]?.cashier || "";
	return {
		v: 1,
		scope: normalizedScope,
		cashier: cashier || null,
		// Do not accidentally use a former cashier's batch after an online
		// cashier has prepared a newer one on this shared terminal.
		tickets: cashier
			? tickets.filter((ticket) => ticket.cashier === cashier)
			: [],
	};
}

async function reconcileReservedTicketStates(
	batch: StoredAuthorizationBatch,
	outbox: any,
	preferredClientRequestId = "",
) {
	let changed = false;
	const now = Date.now();
	for (const ticket of batch.tickets) {
		if (ticket.status !== "reserved") continue;
		const outboxEntry = await outbox
			.where("client_request_id")
			.equals(ticket.client_request_id)
			.first();
		if (outboxEntry) {
			ticket.status = "consumed";
			ticket.consumed_at = ticket.consumed_at || new Date().toISOString();
			changed = true;
			continue;
		}
		const reservedAt = Date.parse(String(ticket.reserved_at || ""));
		const reservationExpired =
			!Number.isFinite(reservedAt) || now - reservedAt >= RESERVATION_LEASE_MS;
		if (
			reservationExpired &&
			ticket.client_request_id !== preferredClientRequestId
		) {
			ticket.status = "available";
			ticket.reserved_at = null;
			changed = true;
		}
	}
	return changed;
}

async function reconcileReservedTickets(
	scope: OfflineSaleAuthorizationScope,
	preferredClientRequestId = "",
) {
	await ensureReady();
	const key = storageKey(scope);
	const table = db.table("keyval");
	const outbox = db.table("invoice_outbox");
	return db.transaction("rw", table, outbox, async () => {
		const batch = normalizeStoredBatch((await table.get(key))?.value, scope);
		if (
			await reconcileReservedTicketStates(
				batch,
				outbox,
				preferredClientRequestId,
			)
		) {
			await table.put({ key, value: batch });
		}
		return { key, batch };
	});
}

/** Store server-issued tickets. This intentionally never mirrors to localStorage. */
export async function saveOfflineCashSaleAuthorizations(
	scope: OfflineSaleAuthorizationScope,
	tickets: unknown[],
) {
	await ensureReady();
	const normalizedScope = normalizeScope(scope);
	const key = storageKey(normalizedScope);
	const table = db.table("keyval");
	return db.transaction("rw", table, async () => {
		const current = normalizeStoredBatch(
			(await table.get(key))?.value,
			normalizedScope,
		);
		const prepared: OfflineCashSaleAuthorizationTicket[] = [];
		const cashiers = new Set<string>();
		for (const candidate of tickets || []) {
			const ticket = normalizeTicket(candidate);
			if (!ticket || prepared.some((item) => item.client_request_id === ticket.client_request_id)) continue;
			if (ticket.owner_user !== normalizedScope.user) {
				throw new Error(
					"Offline cash-sale authorization belongs to a different signed-in user",
				);
			}
			prepared.push(ticket);
			cashiers.add(ticket.cashier);
		}
		if (!prepared.length) {
			return clone(current.tickets.filter((ticket) => ticket.status === "available"));
		}
		if (cashiers.size !== 1) {
			throw new Error("Offline cash-sale authorization batch contains more than one cashier");
		}
		const [cashier] = Array.from(cashiers);
		const next = normalizeStoredBatch(
			{
				cashier,
				tickets: prepared.map((ticket) => ({
					...ticket,
					status: "available",
					reserved_at: null,
					consumed_at: null,
				})),
			},
			normalizedScope,
		);
		await table.put({ key, value: next });
		return clone(next.tickets.filter((ticket) => ticket.status === "available"));
	});
}

export async function getAvailableOfflineCashSaleAuthorizations(
	scope: OfflineSaleAuthorizationScope,
) {
	const { batch } = await reconcileReservedTickets(scope);
	return clone(
		batch.tickets.filter(
			(ticket) => ticket.status === "available" && isUnexpired(ticket),
		),
	);
}

/** Atomically reserve exactly one pre-bound ticket for the open signing dialog. */
export async function reserveOfflineCashSaleAuthorization(
	scope: OfflineSaleAuthorizationScope,
	documentType: "Sales Invoice" | "POS Invoice",
	preferredClientRequestId = "",
) {
	await ensureReady();
	const key = storageKey(scope);
	const table = db.table("keyval");
	const outbox = db.table("invoice_outbox");
	return db.transaction("rw", table, outbox, async () => {
		const batch = normalizeStoredBatch((await table.get(key))?.value, scope);
		const preferredId = normalized(preferredClientRequestId);
		const reconciled = await reconcileReservedTicketStates(
			batch,
			outbox,
			preferredId,
		);
		const ticket = preferredId
			? batch.tickets.find(
					(candidate) =>
						candidate.client_request_id === preferredId &&
						candidate.document_type === documentType &&
						["available", "reserved"].includes(candidate.status) &&
						isUnexpired(candidate),
				)
			: batch.tickets.find(
					(candidate) =>
						candidate.status === "available" &&
						candidate.document_type === documentType &&
						isUnexpired(candidate),
				);
		if (!ticket) {
			if (reconciled) {
				await table.put({ key, value: batch });
			}
			return null;
		}
		if (ticket.status !== "reserved") {
			ticket.status = "reserved";
			ticket.reserved_at = new Date().toISOString();
		}
		await table.put({ key, value: batch });
		return clone(ticket);
	});
}

export async function releaseOfflineCashSaleAuthorization(
	scope: OfflineSaleAuthorizationScope,
	clientRequestId: string,
) {
	await ensureReady();
	const key = storageKey(scope);
	const table = db.table("keyval");
	const outbox = db.table("invoice_outbox");
	return db.transaction("rw", table, outbox, async () => {
		const batch = normalizeStoredBatch((await table.get(key))?.value, scope);
		const ticket = batch.tickets.find(
			(candidate) => candidate.client_request_id === normalized(clientRequestId),
		);
		if (!ticket || ticket.status !== "reserved") return false;
		const outboxEntry = await outbox
			.where("client_request_id")
			.equals(ticket.client_request_id)
			.first();
		if (outboxEntry) {
			ticket.status = "consumed";
			ticket.consumed_at = ticket.consumed_at || new Date().toISOString();
			await table.put({ key, value: batch });
			return false;
		}
		ticket.status = "available";
		ticket.reserved_at = null;
		await table.put({ key, value: batch });
		return true;
	});
}

/** Remove a ticket only after its immutable invoice intent is durable in the outbox. */
export async function consumeOfflineCashSaleAuthorization(
	scope: OfflineSaleAuthorizationScope,
	clientRequestId: string,
) {
	await ensureReady();
	const key = storageKey(scope);
	const table = db.table("keyval");
	const outbox = db.table("invoice_outbox");
	return db.transaction("rw", table, outbox, async () => {
		const batch = normalizeStoredBatch((await table.get(key))?.value, scope);
		const ticket = batch.tickets.find(
			(candidate) => candidate.client_request_id === normalized(clientRequestId),
		);
		if (!ticket) return false;
		const outboxEntry = await outbox
			.where("client_request_id")
			.equals(ticket.client_request_id)
			.first();
		if (!outboxEntry) return false;
		ticket.status = "consumed";
		ticket.consumed_at = new Date().toISOString();
		await table.put({ key, value: batch });
		return true;
	});
}
