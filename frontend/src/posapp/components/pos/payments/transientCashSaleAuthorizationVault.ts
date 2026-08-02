import type { OfflineCashSaleAuthorizationTicket } from "../../../../offline/offlineSaleAuthorizations";

/**
 * Browser-memory-only bearer vault for a live cashier-signing dialog.
 *
 * Vue exposes all top-level `<script setup>` variables to component devtools,
 * including plain `let` values. Ticket bearers therefore belong in this module
 * closure, addressed only by an opaque Symbol retained by the component. The
 * vault is naturally cleared on page reload and explicitly cleared after a
 * signing result/cancel.
 */

const authorizations = new Map<symbol, OfflineCashSaleAuthorizationTicket>();

export function createTransientCashSaleAuthorizationSlot() {
	return Symbol("cashier-signing-offline-authorization");
}

export function storeTransientCashSaleAuthorization(
	slot: symbol,
	authorization: OfflineCashSaleAuthorizationTicket,
) {
	authorizations.set(slot, authorization);
}

export function getTransientCashSaleAuthorization(slot: symbol) {
	return authorizations.get(slot) || null;
}

export function clearTransientCashSaleAuthorization(slot: symbol) {
	const authorization = authorizations.get(slot) || null;
	authorizations.delete(slot);
	return authorization;
}
