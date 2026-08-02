import api from "./api";
import type { OfflineCashSaleAuthorizationTicket } from "../../offline/offlineSaleAuthorizations";

const VALIDATE_CASHIER_SIGNATURE_METHOD =
	"posawesome.posawesome.api.employees.validate_cashier_signature";
const PREPARE_OFFLINE_CASH_SALES_METHOD =
	"posawesome.posawesome.api.offline_sale_authorizations.issue_offline_cash_sale_authorizations";
const REAUTHORIZE_OFFLINE_CASH_SALE_METHOD =
	"posawesome.posawesome.api.offline_sale_authorizations.reauthorize_offline_cash_sale_authorization";

export interface CashierSignatureValidation {
	valid: boolean;
}

export interface PreparedOfflineCashSaleAuthorizations {
	tickets: OfflineCashSaleAuthorizationTicket[];
}

/**
 * The exact immutable command whose browser-only bearer may be replaced.
 *
 * The PIN and bearer are intentionally accepted only as transient request
 * values. Callers must pass the returned bearer directly to the guarded
 * IndexedDB replacement operation; neither credential belongs in component
 * state, localStorage, a journal, nor a notification.
 */
export interface OfflineCashSaleReauthorizationRequest {
	clientRequestId: string;
	documentType: "Sales Invoice" | "POS Invoice";
	invoice: Record<string, any>;
	data: Record<string, any>;
	offlineSaleAuthorization: string;
}

export interface ReauthorizedOfflineCashSaleAuthorization {
	ticket: OfflineCashSaleAuthorizationTicket;
	approval_level: "requires_reauthorization" | "requires_supervisor_review";
}

export function validateCashierSignature(
	posProfile: string,
	cashierPin: string,
): Promise<CashierSignatureValidation> {
	return api.call<CashierSignatureValidation>(
		VALIDATE_CASHIER_SIGNATURE_METHOD,
		{
			pos_profile: posProfile,
			pin: cashierPin,
		},
		{
			timeoutMs: 10_000,
			type: "POST",
		},
	);
}

/** Replenishes bounded offline tickets without delaying the active sale. */
export function prepareOfflineCashSaleAuthorizations(
	posProfile: string,
	cashierPin: string,
	documentType: "Sales Invoice" | "POS Invoice",
): Promise<PreparedOfflineCashSaleAuthorizations> {
	return api.call<PreparedOfflineCashSaleAuthorizations>(
		PREPARE_OFFLINE_CASH_SALES_METHOD,
		{
			pos_profile: posProfile,
			pin: cashierPin,
			document_type: documentType,
		},
		{
			timeoutMs: 10_000,
			type: "POST",
		},
	);
}

/**
 * Obtains a fresh, payload-bound ticket for one already-queued offline sale.
 *
 * This is deliberately separate from ticket prefetch: the backend verifies the
 * former bearer, fresh PIN, authenticated POS scope, immutable command ID, and
 * payload before issuing a replacement. It never creates a new sale.
 */
export async function reauthorizeOfflineCashSaleAuthorization(
	posProfile: string,
	cashierPin: string,
	request: OfflineCashSaleReauthorizationRequest,
): Promise<ReauthorizedOfflineCashSaleAuthorization> {
	const clientRequestId = String(request?.clientRequestId || "").trim();
	const offlineSaleAuthorization = String(
		request?.offlineSaleAuthorization || "",
	).trim();
	const pin = String(cashierPin || "").trim();
	if (
		!String(posProfile || "").trim() ||
		!clientRequestId ||
		!offlineSaleAuthorization ||
		!pin
	) {
		throw new Error(
			"Offline sale reauthorization requires its POS Profile, request ID, and cashier PIN",
		);
	}
	if (!request?.invoice || !request?.data) {
		throw new Error(
			"Offline sale reauthorization requires the queued sale payload",
		);
	}

	const response = await api.call<ReauthorizedOfflineCashSaleAuthorization>(
		REAUTHORIZE_OFFLINE_CASH_SALE_METHOD,
		{
			pos_profile: posProfile,
			pin,
			client_request_id: clientRequestId,
			document_type: request.documentType,
			invoice: request.invoice,
			data: request.data,
			offline_sale_authorization: offlineSaleAuthorization,
		},
		{
			timeoutMs: 10_000,
			type: "POST",
		},
	);

	const ticket = response?.ticket;
	if (
		!ticket ||
		!String(ticket.authorization || "").trim() ||
		!String(ticket.owner_user || "").trim() ||
		String(ticket.client_request_id || "").trim() !== clientRequestId ||
		ticket.document_type !== request.documentType
	) {
		throw new Error(
			"Offline sale reauthorization returned an invalid ticket",
		);
	}
	if (
		!["requires_reauthorization", "requires_supervisor_review"].includes(
			response?.approval_level,
		)
	) {
		throw new Error(
			"Offline sale reauthorization returned an invalid approval level",
		);
	}
	return response;
}
