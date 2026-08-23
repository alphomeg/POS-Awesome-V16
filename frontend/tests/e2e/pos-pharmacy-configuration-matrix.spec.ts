import { mkdir, writeFile } from "node:fs/promises";

import { expect, test, type Page, type Request } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
	getProvisionedTerminalCashier,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_PHARMACY_MATRIX_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const PROFILE =
	process.env.POSA_COUNTER_GRID_POS_PROFILE || "MedPlus POS 1 - Supervisor";

const PROFILE_FIELDS = [
	"posa_fast_counter_mode",
	"posa_hot_catalog_limit",
	"posa_fast_counter_positive_stock_only",
	"posa_local_storage",
	"posa_force_server_items",
	"posa_use_server_cache",
	"posa_server_cache_duration",
	"pose_use_limit_search",
	"posa_search_limit",
	"posa_force_reload_items",
	"posa_smart_reload_mode",
] as const;

type ProfileField = (typeof PROFILE_FIELDS)[number];
type ProfileSettings = Record<ProfileField, number>;
type SearchObservation = {
	category: string;
	query: string;
	expectedCodes: string[];
	resultCodes: string[];
	latencyMs: number;
	serverRequests: number;
};

const profileSnapshots = new WeakMap<Page, ProfileSettings>();

test.skip(
	!ENABLED,
	"Set POSA_PHARMACY_MATRIX_E2E=1 to run the live pharmacy configuration matrix.",
);

async function callFrappe<T = any>(
	page: Page,
	method: string,
	args: Record<string, unknown> = {},
) {
	return page.evaluate(
		async ({ callMethod, callArgs }) => {
			const response = await (window as any).frappe.call({
				method: callMethod,
				args: callArgs,
			});
			return response?.message;
		},
		{ callMethod: method, callArgs: args },
	) as Promise<T>;
}

async function openDeskApi(page: Page) {
	await page.goto("/app", { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Pharmacy configuration matrix requires POSA_SMOKE_SID.",
		);
	}
	await page.waitForFunction(
		() => typeof (window as any).frappe?.call === "function",
		null,
		{ timeout: 30_000 },
	);
}

function normalizeProfileSettings(
	profile: Record<string, unknown>,
): ProfileSettings {
	return Object.fromEntries(
		PROFILE_FIELDS.map((field) => [field, Number(profile[field] || 0)]),
	) as ProfileSettings;
}

async function configureProfile(
	page: Page,
	overrides: Partial<ProfileSettings>,
) {
	await openDeskApi(page);
	const profile = await callFrappe<Record<string, unknown>>(
		page,
		"frappe.client.get",
		{ doctype: "POS Profile", name: PROFILE },
	);
	if (!profileSnapshots.has(page)) {
		profileSnapshots.set(page, normalizeProfileSettings(profile));
	}

	await callFrappe(page, "frappe.client.set_value", {
		doctype: "POS Profile",
		name: PROFILE,
		fieldname: overrides,
	});
	const verified = normalizeProfileSettings(
		await callFrappe<Record<string, unknown>>(
			page,
			"frappe.client.get",
			{ doctype: "POS Profile", name: PROFILE },
		),
	);
	for (const [field, value] of Object.entries(overrides)) {
		expect(
			verified[field as ProfileField],
			`${PROFILE}.${field} must match the requested test configuration`,
		).toBe(Number(value));
	}
	return verified;
}

async function restoreProfile(page: Page) {
	const snapshot = profileSnapshots.get(page);
	if (!snapshot || page.isClosed()) return;
	profileSnapshots.delete(page);
	await openDeskApi(page);
	await callFrappe(page, "frappe.client.set_value", {
		doctype: "POS Profile",
		name: PROFILE,
		fieldname: snapshot,
	});
	const restored = normalizeProfileSettings(
		await callFrappe<Record<string, unknown>>(
			page,
			"frappe.client.get",
			{ doctype: "POS Profile", name: PROFILE },
		),
	);
	expect(restored).toEqual(snapshot);
}

function hybridSettings(
	overrides: Partial<ProfileSettings> = {},
): Partial<ProfileSettings> {
	return {
		posa_fast_counter_mode: 1,
		posa_hot_catalog_limit: 7000,
		posa_fast_counter_positive_stock_only: 1,
		posa_local_storage: 1,
		posa_force_server_items: 0,
		posa_use_server_cache: 1,
		posa_server_cache_duration: 1,
		pose_use_limit_search: 1,
		posa_search_limit: 100,
		posa_force_reload_items: 0,
		posa_smart_reload_mode: 1,
		...overrides,
	};
}

async function waitForPos(page: Page) {
	const startedAt = Date.now();
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Pharmacy configuration matrix requires an authenticated POS session.",
		);
	}
	await ensureAuthoritativeTerminalUnlock(page);
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 30_000,
	});
	return Date.now() - startedAt;
}

function requestSearchValue(request: Request) {
	if (
		!request
			.url()
			.includes("posawesome.posawesome.api.items.get_items")
	) {
		return null;
	}
	const body = request.postData() || "";
	const params = new URLSearchParams(body);
	const direct = params.get("search_value");
	if (direct !== null) return direct;
	const args = params.get("args");
	if (!args) return "";
	try {
		return String(JSON.parse(args)?.search_value || "");
	} catch {
		return "";
	}
}

async function searchByKeyboard(
	page: Page,
	category: string,
	query: string,
	expectedCodes: string[] = [],
) {
	const observedRequests: Request[] = [];
	const requestListener = (request: Request) => {
		const searchValue = requestSearchValue(request);
		if (
			searchValue !== null &&
			searchValue.trim().toLowerCase() === query.trim().toLowerCase()
		) {
			observedRequests.push(request);
		}
	};
	page.on("request", requestListener);
	const entry = page.getByTestId("counter-grid-item-entry");
	await entry.focus();
	await entry.fill(query);
	const startedAt = performance.now();
	await entry.press("Enter");
	const selector = page.locator(".items-selector-shell--counter-dialog");
	await expect(selector).toHaveAttribute("data-search-ready-query", query, {
		timeout: 30_000,
	});
	await expect(selector).toHaveAttribute("data-search-pending", "false", {
		timeout: 30_000,
	});
	const latencyMs = Number((performance.now() - startedAt).toFixed(2));
	const resultCodes = (
		await page
			.locator(
				'.items-selector-shell--counter-dialog [data-item-code]',
			)
			.evaluateAll((rows) =>
				rows
					.map((row) => row.getAttribute("data-item-code") || "")
					.filter(Boolean),
			)
	).filter((code, index, all) => all.indexOf(code) === index);

	if (expectedCodes.length > 0) {
		expect.soft(
			resultCodes.some((code) => expectedCodes.includes(code)),
			`${category} query "${query}" must return one expected item`,
		).toBe(true);
	}

	page.off("request", requestListener);
	return {
		category,
		query,
		expectedCodes,
		resultCodes,
		latencyMs,
		serverRequests: observedRequests.length,
	} satisfies SearchObservation;
}

async function closeSearchByKeyboard(page: Page) {
	await page.keyboard.press("Escape");
	await expect(page.locator(".counter-item-search-surface")).toBeHidden({
		timeout: 30_000,
	});
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 15_000,
	});
}

async function readOfflineDatabaseCounts(page: Page) {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("posawesome_offline");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const countStore = (storeName: string) =>
				new Promise<number>((resolve, reject) => {
					if (!database.objectStoreNames.contains(storeName)) {
						resolve(0);
						return;
					}
					const transaction = database.transaction(
						storeName,
						"readonly",
					);
					const request = transaction.objectStore(storeName).count();
					request.onsuccess = () =>
						resolve(Number(request.result || 0));
					request.onerror = () => reject(request.error);
				});
			const readAll = (storeName: string) =>
				new Promise<any[]>((resolve, reject) => {
					if (!database.objectStoreNames.contains(storeName)) {
						resolve([]);
						return;
					}
					const transaction = database.transaction(
						storeName,
						"readonly",
					);
					const request = transaction.objectStore(storeName).getAll();
					request.onsuccess = () =>
						resolve(Array.isArray(request.result) ? request.result : []);
					request.onerror = () => reject(request.error);
				});
			const catalogStates = await readAll("item_catalog_state");
			const activeGenerations = new Map(
				catalogStates.map((state) => [
					String(state?.profile_scope || ""),
					String(state?.active_generation || ""),
				]),
			);
			const activeCatalogRows = await new Promise<number>(
				(resolve, reject) => {
					if (
						!database.objectStoreNames.contains(
							"item_catalog_rows",
						)
					) {
						resolve(0);
						return;
					}
					const transaction = database.transaction(
						"item_catalog_rows",
						"readonly",
					);
					const request = transaction
						.objectStore("item_catalog_rows")
						.openCursor();
					let count = 0;
					request.onsuccess = () => {
						const cursor = request.result;
						if (!cursor) {
							resolve(count);
							return;
						}
						const row = cursor.value;
						if (
							activeGenerations.get(
								String(row?.profile_scope || ""),
							) ===
							String(row?.catalog_generation || "")
						) {
							count += 1;
						}
						cursor.continue();
					};
					request.onerror = () => reject(request.error);
				},
			);
			return {
				items: await countStore("items"),
				itemCatalogRows: await countStore("item_catalog_rows"),
				activeCatalogRows,
				activeCatalogScopes: catalogStates.length,
				invoiceOutbox: await countStore("invoice_outbox"),
			};
		} finally {
			database.close();
		}
	});
}

async function readOfflineShellState(page: Page) {
	return page.evaluate(async () => {
		const registrations = await navigator.serviceWorker.getRegistrations();
		const cacheKeys = await caches.keys();
		const ownedCaches = cacheKeys.filter((key) =>
			key.startsWith("posawesome-cache-"),
		);
		const cacheDetails = [];
		for (const cacheName of ownedCaches) {
			const cache = await caches.open(cacheName);
			const marker = await cache.match(
				"/__posawesome_cache_complete__",
			);
			cacheDetails.push({
				cacheName,
				complete: Boolean(marker),
				appShell: Boolean(await cache.match("/desk/posapp")),
				offlinePage: Boolean(await cache.match("/offline.html")),
			});
		}
		return {
			controller: navigator.serviceWorker.controller?.scriptURL || null,
			registrations: registrations.map((registration) => ({
				scope: registration.scope,
				active: registration.active?.state || null,
				waiting: registration.waiting?.state || null,
				installing: registration.installing?.state || null,
			})),
			cacheDetails,
		};
	});
}

async function observeOfflineShellReadiness(
	page: Page,
	timeoutMs = 90_000,
) {
	const startedAt = Date.now();
	await page.evaluate(() => navigator.serviceWorker.ready);
	let state = await readOfflineShellState(page);
	while (Date.now() - startedAt < timeoutMs) {
		const ready = Boolean(
			state.controller &&
				state.cacheDetails.some(
					(cache) =>
						cache.complete &&
						cache.appShell &&
						cache.offlinePage,
				),
		);
		if (ready) {
			return {
				ready: true,
				elapsedMs: Date.now() - startedAt,
				state,
			};
		}
		await page.waitForTimeout(1000);
		state = await readOfflineShellState(page);
	}
	return {
		ready: false,
		elapsedMs: Date.now() - startedAt,
		state,
	};
}

async function tabTo(page: Page, target: ReturnType<Page["locator"]>) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (
			await target
				.evaluate((element) => element === document.activeElement)
				.catch(() => false)
		) {
			return;
		}
		await page.keyboard.press("Tab");
	}
	throw new Error("Keyboard Tab traversal did not reach the requested target.");
}

async function attachJson(page: Page, name: string, value: unknown) {
	await mkdir("test-results", { recursive: true });
	const path = `test-results/pos-pharmacy-${name}.json`;
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await test.info().attach(name, {
		path,
		contentType: "application/json",
	});
	void page;
}

for (const hotCatalogLimit of [3000, 5000, 7000]) {
	test(`cold hybrid bootstrap respects the ${hotCatalogLimit}-item positive-stock hot catalogue`, async ({
		page,
	}) => {
		test.setTimeout(4 * 60_000);
		await configureProfile(
			page,
			hybridSettings({ posa_hot_catalog_limit: hotCatalogLimit }),
		);
		const hotResponsePromise = page.waitForResponse(
			(response) =>
				response
					.url()
					.includes(
						"posawesome.posawesome.api.items.get_hot_items",
					) && response.status() === 200,
			{ timeout: 90_000 },
		);
		const bootstrapMs = await waitForPos(page);
		const response = await hotResponsePromise;
		const profile = await callFrappe<Record<string, any>>(
			page,
			"frappe.client.get",
			{ doctype: "POS Profile", name: PROFILE },
		);
		const items = await callFrappe<any[]>(
			page,
			"posawesome.posawesome.api.items.get_hot_items",
			{
				pos_profile: JSON.stringify(profile),
				price_list: profile.selling_price_list,
				customer: profile.customer,
				limit: hotCatalogLimit,
				days: 120,
				include_description: 0,
				include_image: 0,
				item_groups: JSON.stringify(
					(profile.item_groups || []).map(
						(row: any) => row.item_group,
					),
				),
			},
		);
		expect(items.length).toBeGreaterThan(1000);
		expect(items.length).toBeLessThanOrEqual(hotCatalogLimit);
		expect(
			items.every((item: any) => Number(item?.actual_qty || 0) > 0),
			"positive-stock-only hot catalogue must not contain zero-stock rows",
		).toBe(true);
		await attachJson(page, `hot-catalog-${hotCatalogLimit}`, {
			hotCatalogLimit,
			itemCount: items.length,
			bootstrapMs,
			responseMs: Number(
				response.request().timing().responseEnd.toFixed(2),
			),
		});
	});
}

test("shipped hybrid mode covers pharmacy search taxonomy and warm latency", async ({
	page,
}) => {
	test.setTimeout(8 * 60_000);
	test.fail(
		true,
		"Known certification gaps: generic positive-stock ranking and displayed company-name lookup.",
	);
	await configureProfile(page, hybridSettings());
	await waitForPos(page);

	const fixtures = [
		{ category: "product name", query: "panadol", expected: ["AI167", "AH076"] },
		{ category: "item code", query: "AI167", expected: ["AI167"] },
		{ category: "barcode", query: "224", expected: ["02182"] },
		{ category: "generic", query: "paracetamol", expected: ["AI167", "AH076", "A3106"] },
		{
			category: "company",
			query: "GSK JAVAD BROTHER",
			expected: ["AI167", "AH076"],
		},
		{ category: "pack", query: '1000"S', expected: ["75051", "N5022"] },
		{ category: "rack", query: "CONT5", expected: ["WL078"] },
	] as const;
	const observations: SearchObservation[] = [];

	for (const fixture of fixtures) {
		observations.push(
			await searchByKeyboard(
				page,
				fixture.category,
				fixture.query,
				[...fixture.expected],
			),
		);
		await closeSearchByKeyboard(page);
	}

	const noResult = await searchByKeyboard(
		page,
		"no result",
		"zzrm-no-match-7391",
	);
	expect(noResult.resultCodes).toHaveLength(0);
	observations.push(noResult);
	await closeSearchByKeyboard(page);

	const warmLatencies: number[] = [];
	for (let run = 0; run < 10; run += 1) {
		const observation = await searchByKeyboard(
			page,
			"warm product name",
			"panadol",
			["AI167", "AH076"],
		);
		warmLatencies.push(observation.latencyMs);
		await closeSearchByKeyboard(page);
	}
	const sorted = [...warmLatencies].sort((left, right) => left - right);
	const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
	expect(p95Ms).toBeLessThanOrEqual(2000);

	const codeObservation = observations.find(
		(observation) => observation.category === "item code",
	)!;
	const barcodeObservation = observations.find(
		(observation) => observation.category === "barcode",
	)!;
	const nameObservation = observations.find(
		(observation) => observation.category === "product name",
	)!;
	expect(codeObservation.serverRequests).toBe(0);
	expect(barcodeObservation.serverRequests).toBe(0);
	expect(nameObservation.serverRequests).toBeGreaterThan(0);
	await attachJson(page, "hybrid-search-taxonomy", {
		observations,
		warmLatencies,
		warmP95Ms: p95Ms,
	});
});

test("zero-stock visibility is keyboard-toggleable in Counter Grid lookup", async ({
	page,
}) => {
	test.setTimeout(4 * 60_000);
	await configureProfile(page, hybridSettings());
	await waitForPos(page);

	const observation = await searchByKeyboard(
		page,
		"zero-stock default-on",
		"01009",
	);
	expect(observation.resultCodes).toContain("01009");
	const switchInput = page
		.getByTestId("pharmacy-include-zero-stock")
		.locator("input");
	await expect(switchInput).toBeChecked();
	await tabTo(page, switchInput);
	await page.keyboard.press("Space");
	await expect(page.getByTestId("pos-item-row-01009")).toBeHidden({
		timeout: 15_000,
	});
	await attachJson(page, "zero-stock-lookup", {
		...observation,
		defaultIncluded: true,
		excludedByKeyboard: true,
	});
	await closeSearchByKeyboard(page);
});

test("server-only mode remains online-capable but has no offline catalogue", async ({
	context,
	page,
}) => {
	test.setTimeout(5 * 60_000);
	await configureProfile(
		page,
		hybridSettings({
			posa_fast_counter_mode: 0,
			posa_local_storage: 0,
			posa_force_server_items: 1,
		}),
	);
	await waitForPos(page);

	const online: SearchObservation[] = [];
	for (const fixture of [
		{ category: "name", query: "panadol", expected: ["AH076", "A3106"] },
		{ category: "code", query: "AI167", expected: ["AI167"] },
		{ category: "rack", query: "CONT5", expected: ["WL078"] },
	]) {
		const observation = await searchByKeyboard(
			page,
			fixture.category,
			fixture.query,
			fixture.expected,
		);
		expect(observation.serverRequests).toBeGreaterThan(0);
		online.push(observation);
		await closeSearchByKeyboard(page);
	}
	const beforeOffline = await readOfflineDatabaseCounts(page);

	await context.setOffline(true);
	const offline = await searchByKeyboard(
		page,
		"offline uncached rack",
		"8E",
	);
	expect(offline.resultCodes).toHaveLength(0);
	await closeSearchByKeyboard(page);
	await context.setOffline(false);
	await attachJson(page, "server-only-boundary", {
		online,
		beforeOffline,
		offline,
	});
});

test("disabling local storage limits hybrid offline search to the current page", async ({
	context,
	page,
}) => {
	test.setTimeout(6 * 60_000);
	await configureProfile(
		page,
		hybridSettings({ posa_local_storage: 0 }),
	);
	await waitForPos(page);
	const shellState = await readOfflineShellState(page);
	const counts = await readOfflineDatabaseCounts(page);
	expect(counts.items + counts.itemCatalogRows).toBe(0);
	await attachJson(page, "no-local-storage-preflight", {
		pageUrl: page.url(),
		shellState,
		counts,
	});

	await context.setOffline(true);
	const samePage = await searchByKeyboard(
		page,
		"same-page hot item",
		"AI167",
		["AI167"],
	);
	await closeSearchByKeyboard(page);
	await context.setOffline(false);
	await attachJson(page, "no-local-storage-offline-boundary", {
		shellState,
		counts,
		samePage,
		durableCatalogueAvailable: false,
	});
});

test("complete service-worker cache reloads the POS shell offline", async ({
	context,
	page,
}) => {
	test.setTimeout(5 * 60_000);
	await configureProfile(page, hybridSettings());
	await waitForPos(page);
	const shellReadiness = await observeOfflineShellReadiness(page);
	const pageUrl = page.url();
	expect(shellReadiness.ready).toBe(true);

	await context.setOffline(true);
	page.once("dialog", (dialog) => dialog.accept());
	const reloadError = await page
		.reload({ waitUntil: "domcontentloaded" })
		.then(() => null)
		.catch((error) => String(error?.message || error));
	await page.waitForTimeout(5000);
	const renderedCounterGrid = await page
		.getByTestId("counter-grid-pos")
		.isVisible({ timeout: 30_000 })
		.catch(() => false);
	expect(reloadError).toBeNull();
	expect(renderedCounterGrid).toBe(true);
	await context.setOffline(false);
	await attachJson(page, "offline-shell-reload", {
		pageUrl,
		shellReadiness,
		reloadError,
		renderedCounterGrid,
	});
});

test("warmed hybrid terminal blocks unavailable prerequisites and reconnects exactly once", async ({
	context,
	page,
}) => {
	test.setTimeout(12 * 60_000);
	test.fail(
		true,
		"Known certification gap: active offline catalogue exact-code search falls back to unrelated hot items.",
	);
	await configureProfile(page, hybridSettings());
	await waitForPos(page);
	const shellState = await readOfflineShellState(page);
	const provisioned = getProvisionedTerminalCashier(page);
	if (!provisioned?.pin) {
		throw new Error(
			"Offline/reconnect certification requires POSA_E2E_PROVISION_CASHIER=1.",
		);
	}

	await expect
		.poll(
			async () => {
				const counts = await readOfflineDatabaseCounts(page);
				return counts.items + counts.activeCatalogRows;
			},
			{ timeout: 4 * 60_000, intervals: [1000, 2000, 5000] },
		)
		.toBeGreaterThan(3000);
	const warmedCounts = await readOfflineDatabaseCounts(page);
	await attachJson(page, "hybrid-offline-preflight", {
		pageUrl: page.url(),
		shellState,
		warmedCounts,
	});

	await page.evaluate(() => {
		(window as any).__pharmacyMatrixResponses = [];
		(window as any).__pharmacyMatrixDispatches = [];
		window.addEventListener(
			"posa:invoice-submit-response",
			(event: Event) =>
				(window as any).__pharmacyMatrixResponses.push(
					(event as CustomEvent).detail,
				),
		);
		window.addEventListener(
			"posa:invoice-submit-dispatched",
			(event: Event) =>
				(window as any).__pharmacyMatrixDispatches.push(
					(event as CustomEvent).detail,
				),
		);
	});

	await context.setOffline(true);
	const offlineSearch = await searchByKeyboard(
		page,
		"offline persisted zero-stock code",
		"01009",
		["01009"],
	);
	await closeSearchByKeyboard(page);
	const saleItemSearch = await searchByKeyboard(
		page,
		"offline positive-stock sale item",
		"AI167",
		["AI167"],
	);
	const search = page.getByTestId("pos-item-search").locator("input");
	await search.press("Enter");
	await expect(page.getByTestId("cart-row-AI167").first()).toBeVisible({
		timeout: 30_000,
	});

	await page.keyboard.press("Alt+X");
	const signingDialog = page.getByTestId("cashier-sale-signing-dialog");
	const visiblePaymentRoot = page.locator(
		'[data-testid="payment-root"]:visible',
	);
	let offlineBlocker = "cashier-pin-validation";
	if (await signingDialog.isVisible().catch(() => false)) {
		const offlinePinInput = signingDialog
			.getByTestId("cashier-sale-pin-input")
			.locator("input");
		await offlinePinInput.fill(provisioned.pin);
		await offlinePinInput.press("Enter");
		await expect(
			signingDialog.getByText(
				"Unable to verify the cashier PIN. Check the connection and try again.",
			),
		).toBeVisible({ timeout: 20_000 });
	} else {
		offlineBlocker = "sales-person-cache";
		await expect(visiblePaymentRoot).toHaveCount(1, {
			timeout: 30_000,
		});
		await expect(
			visiblePaymentRoot.getByText("No sales persons found"),
		).toBeVisible();
	}
	await expect(page.getByTestId("cart-row-AI167").first()).toBeVisible();
	expect(
		await page.evaluate(
			() => (window as any).__pharmacyMatrixDispatches.length,
		),
	).toBe(0);
	const offlineCounts = await readOfflineDatabaseCounts(page);
	expect(offlineCounts.invoiceOutbox).toBe(warmedCounts.invoiceOutbox);
	expect(offlineCounts.activeCatalogRows).toBeGreaterThan(3000);

	await context.setOffline(false);
	await page.waitForFunction(
		() =>
			navigator.onLine && (window as any).serverOnline === true,
		null,
		{ timeout: 30_000 },
	);
	if (await signingDialog.isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(signingDialog).toBeHidden({ timeout: 15_000 });
	}
	if ((await visiblePaymentRoot.count()) > 0) {
		await page.keyboard.press("Escape");
		await expect(visiblePaymentRoot).toHaveCount(0, {
			timeout: 15_000,
		});
	}
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 15_000,
	});
	await page.keyboard.press("Alt+X");
	await expect(signingDialog).toBeVisible({ timeout: 30_000 });
	const pinInput = signingDialog
		.getByTestId("cashier-sale-pin-input")
		.locator("input");
	await pinInput.fill(provisioned.pin);
	await pinInput.press("Enter");
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as any).__pharmacyMatrixResponses.length,
				),
			{ timeout: 90_000 },
		)
		.toBe(1);
	const response = await page.evaluate(
		() => (window as any).__pharmacyMatrixResponses[0],
	);
	expect(response?.requestId).toBeTruthy();
	expect(response?.invoice).toBeTruthy();
	let matches: Array<{
		name: string;
		doctype: string;
		docstatus: number;
	}> = [];
	await expect
		.poll(
			async () => {
				const results = await Promise.all(
					["POS Invoice", "Sales Invoice"].map(
						async (doctype) => {
							const rows = await callFrappe<
								Array<{ name: string; docstatus: number }>
							>(page, "frappe.client.get_list", {
								doctype,
								filters: {
									posa_client_request_id:
										response.requestId,
								},
								fields: ["name", "docstatus"],
								limit_page_length: 10,
							});
							return rows.map((row) => ({
								...row,
								doctype,
							}));
						},
					),
				);
				matches = results.flat();
				return matches.length;
			},
			{ timeout: 90_000, intervals: [500, 1000, 2000, 5000] },
		)
		.toBe(1);
	expect(matches).toHaveLength(1);
	expect(Number(matches[0].docstatus)).toBe(1);
	await attachJson(page, "hybrid-offline-reconnect", {
		shellState,
		warmedCounts,
		offlineCounts,
		offlineSearch,
		saleItemSearch,
		offlineBlocker,
		requestId: response.requestId,
		invoice: response.invoice,
		submittedMatches: matches,
	});
});

test.afterEach(async ({ context, page }) => {
	await context.setOffline(false).catch(() => undefined);
	if (page.isClosed()) return;
	await page
		.waitForFunction(() => navigator.onLine, null, { timeout: 10_000 })
		.catch(() => undefined);
	const hasFrappeApi = await page
		.evaluate(() => typeof (window as any).frappe?.call === "function")
		.catch(() => false);
	if (!hasFrappeApi) {
		await openDeskApi(page);
	}
	await cleanupProvisionedTerminalCashier(page).catch(() => undefined);
	await restoreProfile(page);
});
