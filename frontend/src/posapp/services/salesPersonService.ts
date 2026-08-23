/**
 * POS Profile-scoped sales-person options.
 *
 * Sales people are optional invoice metadata, but opening the payment surface
 * must never depend on a live lookup for them. This service gives the POS one
 * shared path for the profile-scoped cache, online refresh, and offline
 * fallback used by both terminal bootstrap and Payments.
 */
import {
	flushPersistQueue,
	getSalesPersonsStorage,
	isOffline,
	setSalesPersonsStorage,
} from "../../offline/index";

export interface SalesPersonOption {
	name: string;
	sales_person_name: string;
	value: string;
	title: string;
}

type SalesPersonLoadOptions = {
	refresh?: boolean;
};

const inFlightRequests = new Map<string, Promise<SalesPersonOption[]>>();

export function getSalesPersonProfileScope(profile: any): string {
	return String(profile?.name || "").trim();
}

export function isSalesPersonLocalCacheEnabled(profile: any): boolean {
	const value = profile?.posa_local_storage;
	return value === true || value === 1 || value === "1" || value === "true";
}

export function normalizeSalesPersonOptions(rows: unknown): SalesPersonOption[] {
	if (!Array.isArray(rows)) {
		return [];
	}

	const seen = new Set<string>();
	return rows.reduce<SalesPersonOption[]>((options, row: any) => {
		const name = String(row?.name || row?.sales_person || row?.value || "").trim();
		if (!name || seen.has(name)) {
			return options;
		}

		seen.add(name);
		const title = String(
			row?.sales_person_name || row?.title || name,
		).trim() || name;
		options.push({
			name,
			sales_person_name: title,
			value: name,
			title,
		});
		return options;
	}, []);
}

export function getProfileSalesPersonOptions(profile: any): SalesPersonOption[] {
	return normalizeSalesPersonOptions(profile?.posa_sales_persons);
}

export function getCachedSalesPersonOptions(profile: any): SalesPersonOption[] {
	if (!isSalesPersonLocalCacheEnabled(profile)) {
		return [];
	}

	return normalizeSalesPersonOptions(
		getSalesPersonsStorage(getSalesPersonProfileScope(profile)),
	);
}

function getImmediateSalesPersonOptions(profile: any): SalesPersonOption[] {
	const cached = getCachedSalesPersonOptions(profile);
	return cached.length ? cached : getProfileSalesPersonOptions(profile);
}

function readFrappeCall() {
	if (typeof window === "undefined") {
		return null;
	}
	return typeof window.frappe?.call === "function" ? window.frappe.call.bind(window.frappe) : null;
}

function fetchSalesPersonOptions(
	profile: any,
	profileScope: string,
	fallback: SalesPersonOption[],
): Promise<SalesPersonOption[]> {
	const call = readFrappeCall();
	if (!call) {
		return Promise.resolve(fallback);
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = (response?: any, persistServerResult = false) => {
			if (settled) return;
			settled = true;
			const serverOptions = normalizeSalesPersonOptions(response?.message);
			const options = serverOptions.length ? serverOptions : fallback;

			void (async () => {
				// A transport/error callback is not an authoritative empty server
				// response. Preserve the last durable list in that case so a brief
				// online failure cannot erase the next offline checkout's metadata.
				if (persistServerResult && isSalesPersonLocalCacheEnabled(profile)) {
					setSalesPersonsStorage(profileScope, serverOptions);
					// Do not report the warm result as ready until it has crossed the
					// IndexedDB durability boundary. This keeps an offline reload from
					// racing a just-fetched cache write.
					await flushPersistQueue();
				}
				resolve(options);
			})().catch(() => resolve(options));
		};

		try {
			const request = call({
				method: "posawesome.posawesome.api.utilities.get_sales_person_names",
				args: { pos_profile: profileScope },
				callback: (response: any) => finish(response, true),
				error: () => finish(),
			});
			if (request && typeof request.then === "function") {
				request.then((response: any) => finish(response, true)).catch(() => finish());
			}
		} catch (_error) {
			finish();
		}
	});
}

/**
 * Resolve display options for a POS Profile without making an offline network
 * request. A cached result is immediately returned unless the caller asks to
 * refresh it while online.
 */
export function loadSalesPersonOptions(
	profile: any,
	{ refresh = false }: SalesPersonLoadOptions = {},
): Promise<SalesPersonOption[]> {
	const profileScope = getSalesPersonProfileScope(profile);
	const cached = getCachedSalesPersonOptions(profile);
	const fallback = getImmediateSalesPersonOptions(profile);

	if (isOffline() || !profileScope || (cached.length && !refresh)) {
		return Promise.resolve(fallback);
	}

	const existingRequest = inFlightRequests.get(profileScope);
	if (existingRequest) {
		return existingRequest;
	}

	const request = fetchSalesPersonOptions(profile, profileScope, fallback).finally(() => {
		inFlightRequests.delete(profileScope);
	});
	inFlightRequests.set(profileScope, request);
	return request;
}

/**
 * Start a non-blocking, durable refresh when terminal/profile data is loaded.
 * Offline terminals only use their already scoped cache or profile-supplied
 * choices and never attempt this RPC.
 */
export function warmSalesPersonOptions(profile: any): Promise<SalesPersonOption[]> {
	if (!isSalesPersonLocalCacheEnabled(profile)) {
		return Promise.resolve(getProfileSalesPersonOptions(profile));
	}

	return loadSalesPersonOptions(profile, { refresh: true });
}
