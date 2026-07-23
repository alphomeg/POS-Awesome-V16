/**
 * POS-owned browser maintenance.
 *
 * This module deliberately never enumerates and clears an origin wholesale.
 * Frappe Desk shares the origin with POS Awesome, so every mutable resource
 * must be explicitly registered here.
 */

export const POS_STORAGE_OWNERSHIP = Object.freeze({
	indexedDbNames: ["posawesome_offline"],
	cachePrefixes: ["posawesome-cache-"],
	serviceWorkerPaths: ["/sw.js"],
	localStorageExact: [
		"networkOnline",
		"serverOnline",
		"use_western_numerals",
	],
	localStoragePrefixes: [
		"posa_",
		"posawesome_",
		"pos_manual_base_",
	],
	sessionStorageExact: ["networkOnline", "serverOnline"],
	sessionStoragePrefixes: [
		"posa_",
		"posawesome_",
		"pos_audit_archive_",
	],
});

export type PosStateInventory = {
	indexedDb: Record<string, number | null>;
	localStorageKeys: number;
	sessionStorageKeys: number;
	cacheNames: string[];
	serviceWorkerScopes: string[];
	operational: {
		invoiceOutbox: number | null;
		writeQueue: number | null;
		legacyQueue: number | null;
		openingShifts: number | null;
		intentJournals: number;
		activeRecoveryPointers: number;
	};
};

function registeredKeys(
	storage: Storage,
	exact: readonly string[],
	prefixes: readonly string[],
) {
	return Object.keys(storage).filter(
		(key) =>
			exact.includes(key) ||
			prefixes.some((prefix) => key.startsWith(prefix)),
	);
}

function isOwnedServiceWorker(registration: ServiceWorkerRegistration) {
	const worker =
		registration.active ||
		registration.waiting ||
		registration.installing;
	if (!worker?.scriptURL) return false;
	try {
		const scriptUrl = new URL(worker.scriptURL, window.location.origin);
		return (
			scriptUrl.origin === window.location.origin &&
			POS_STORAGE_OWNERSHIP.serviceWorkerPaths.includes(
				scriptUrl.pathname,
			)
		);
	} catch {
		return false;
	}
}

async function getOwnedServiceWorkerRegistrations() {
	if (
		typeof navigator === "undefined" ||
		!("serviceWorker" in navigator) ||
		!navigator.serviceWorker.getRegistrations
	) {
		return [];
	}
	const registrations = await navigator.serviceWorker.getRegistrations();
	return Array.from(registrations).filter(isOwnedServiceWorker);
}

async function getOwnedCacheNames() {
	if (typeof caches === "undefined") return [];
	const names = await caches.keys();
	return names.filter((name) =>
		POS_STORAGE_OWNERSHIP.cachePrefixes.some((prefix) =>
			name.startsWith(prefix),
		),
	);
}

async function countIndexedDbTables() {
	const counts: Record<string, number | null> = {};
	try {
		const { db } = await import("../offline/db");
		if (!db.isOpen()) {
			await db.open();
		}
		for (const table of db.tables) {
			try {
				counts[table.name] = await table.count();
			} catch {
				counts[table.name] = null;
			}
		}
	} catch {
		for (const database of POS_STORAGE_OWNERSHIP.indexedDbNames) {
			counts[database] = null;
		}
	}
	return counts;
}

async function countOperationalRecords() {
	const fallback = {
		invoiceOutbox: null,
		writeQueue: null,
		legacyQueue: null,
		openingShifts: null,
	};
	try {
		const { db } = await import("../offline/db");
		if (!db.isOpen()) await db.open();
		const terminalStatuses = new Set(["acknowledged", "synced"]);
		const [invoiceRows, writeRows, legacyRows, openingShifts] =
			await Promise.all([
				db.table("invoice_outbox").toArray(),
				db.table("write_queue").toArray(),
				db.table("queue").toArray(),
				db.table("opening_shifts").count(),
			]);
		return {
			invoiceOutbox: invoiceRows.filter(
				(row) =>
					!terminalStatuses.has(
						String(row?.status || "").toLowerCase(),
					),
			).length,
			writeQueue: writeRows.filter(
				(row) =>
					!terminalStatuses.has(
						String(row?.status || "").toLowerCase(),
					),
			).length,
			legacyQueue: legacyRows.reduce((count, row) => {
				const entries = Array.isArray(row?.value) ? row.value : [];
				return (
					count +
					entries.filter(
						(entry) =>
							!terminalStatuses.has(
								String(entry?.status || "").toLowerCase(),
							),
					).length
				);
			}, 0),
			openingShifts,
		};
	} catch {
		return fallback;
	}
}

export async function getPosStateInventory(): Promise<PosStateInventory> {
	const indexedDb = await countIndexedDbTables();
	const operationalRecords = await countOperationalRecords();
	const localKeys =
		typeof localStorage === "undefined"
			? []
			: registeredKeys(
					localStorage,
					POS_STORAGE_OWNERSHIP.localStorageExact,
					POS_STORAGE_OWNERSHIP.localStoragePrefixes,
				);
	const sessionKeys =
		typeof sessionStorage === "undefined"
			? []
			: registeredKeys(
					sessionStorage,
					POS_STORAGE_OWNERSHIP.sessionStorageExact,
					POS_STORAGE_OWNERSHIP.sessionStoragePrefixes,
				);

	return {
		indexedDb,
		localStorageKeys: localKeys.length,
		sessionStorageKeys: sessionKeys.length,
		cacheNames: await getOwnedCacheNames(),
		serviceWorkerScopes: (
			await getOwnedServiceWorkerRegistrations()
		).map((registration) => registration.scope),
		operational: {
			...operationalRecords,
			intentJournals: localKeys.filter((key) =>
				key.startsWith("posa_invoice_intent_"),
			).length,
			activeRecoveryPointers: localKeys.filter(
				(key) =>
					key === "posa_active_invoice_submission_recovery_v1" ||
					key.startsWith(
						"posa_invoice_recovery_client_effects_v1::",
					),
			).length,
		},
	};
}

export async function repairPosAssets() {
	const cacheNames = await getOwnedCacheNames();
	const registrations = await getOwnedServiceWorkerRegistrations();

	await Promise.all(cacheNames.map((name) => caches.delete(name)));
	await Promise.all(
		registrations.map(async (registration) => {
			for (const worker of [
				registration.active,
				registration.waiting,
				registration.installing,
			]) {
				try {
					worker?.postMessage({ type: "CLIENT_FORCE_UNREGISTER" });
				} catch {
					// Notification is best-effort; unregister is authoritative.
				}
			}
			const removed = await registration.unregister();
			if (!removed) {
				throw new Error(
					`POS service worker could not be unregistered: ${registration.scope}`,
				);
			}
		}),
	);

	return {
		cacheNames,
		serviceWorkerScopes: registrations.map(
			(registration) => registration.scope,
		),
	};
}

async function deleteOwnedIndexedDb(databaseName: string) {
	const { db } = await import("../offline/db");
	if (databaseName === db.name && db.isOpen()) {
		db.close();
	}
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.onsuccess = () => resolve();
		request.onerror = () =>
			reject(
				request.error ||
					new Error(`Failed to delete ${databaseName}`),
			);
		request.onblocked = () =>
			reject(
				new Error(
					`Reset was blocked by another POS tab (${databaseName}). Close other POS tabs and retry.`,
				),
			);
	});
}

function removeRegisteredStorage(
	storage: Storage,
	exact: readonly string[],
	prefixes: readonly string[],
) {
	const keys = registeredKeys(storage, exact, prefixes);
	keys.forEach((key) => storage.removeItem(key));
	return keys;
}

export async function resetLocalPosOwnedState() {
	const before = await getPosStateInventory();
	await repairPosAssets();
	for (const databaseName of POS_STORAGE_OWNERSHIP.indexedDbNames) {
		await deleteOwnedIndexedDb(databaseName);
	}

	const localStorageKeys =
		typeof localStorage === "undefined"
			? []
			: removeRegisteredStorage(
					localStorage,
					POS_STORAGE_OWNERSHIP.localStorageExact,
					POS_STORAGE_OWNERSHIP.localStoragePrefixes,
				);
	const sessionStorageKeys =
		typeof sessionStorage === "undefined"
			? []
			: removeRegisteredStorage(
					sessionStorage,
					POS_STORAGE_OWNERSHIP.sessionStorageExact,
					POS_STORAGE_OWNERSHIP.sessionStoragePrefixes,
				);

	return {
		before,
		removed: {
			databases: [...POS_STORAGE_OWNERSHIP.indexedDbNames],
			localStorageKeys,
			sessionStorageKeys,
		},
	};
}

/**
 * Compatibility wrapper for older imports. It is intentionally POS-scoped.
 */
export async function clearAllCaches(options: {
	confirmBeforeClear?: boolean;
	onSuccess?: () => void;
	onError?: (_error: unknown) => void;
} = {}) {
	try {
		if (
			options.confirmBeforeClear !== false &&
			typeof window !== "undefined" &&
			!window.confirm(
				"Reset POS-owned browser data on this device?",
			)
		) {
			return;
		}
		await resetLocalPosOwnedState();
		options.onSuccess?.();
	} catch (error) {
		options.onError?.(error);
		throw error;
	}
}
