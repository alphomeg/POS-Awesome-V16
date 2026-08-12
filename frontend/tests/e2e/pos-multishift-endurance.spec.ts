import { randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
	expect,
	test,
	type Page,
	type Request,
	type TestInfo,
} from "@playwright/test";

const ENABLED = process.env.POSA_MULTISHIFT_ENDURANCE_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const POS_PROFILE =
	process.env.POSA_MULTISHIFT_PROFILE || "MedPlus POS 1 - Supervisor";
const SHIFT_COUNT = positiveInteger(process.env.POSA_MULTISHIFT_SHIFTS, 10);
const SALES_PER_SHIFT = positiveInteger(
	process.env.POSA_MULTISHIFT_SALES_PER_SHIFT,
	100,
);
const REQUEST_TIMEOUT_MS = 60_000;
const SEARCH_REQUEST_METHOD =
	"posawesome.posawesome.api.items.get_items";
const STOCK_METHOD =
	"posawesome.posawesome.api.item_processing.stock.get_available_qty";
const CANDIDATE_ITEM_CODES = [
	"AI167",
	"B4088",
	"AH076",
	"IK140",
	"HE027",
	"24078",
	"N5022",
	"29988",
	"DT435",
	"A3106",
];

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
	"posa_allow_offline_signed_cash_sales",
	"posa_offline_signed_sale_max_amount",
	"posa_offline_signed_sale_ttl_minutes",
	"posa_offline_signed_sale_ticket_batch_size",
] as const;

type ProfileField = (typeof PROFILE_FIELDS)[number];
type ProfileSettings = Record<ProfileField, number>;
type AvailableItem = {
	itemCode: string;
	availableQty: number;
};
type ItemFixture = AvailableItem & {
	/**
	 * Server-mode deliberately searches by an item name rather than its exact
	 * code. Exact hot-catalog hits are an intentional browser-cache fast path;
	 * a name search exercises the server-search path the first five shifts are
	 * meant to certify.
	 */
	searchQuery: string;
};
type SearchMode = "server" | "browser-cache";
type SaleResult = {
	invoice: string;
	requestId: string;
	itemCode: string;
	searchLatencyMs: number;
	signingLatencyMs: number;
	submissionLatencyMs: number;
	serverRequests: number;
};
type StockSnapshot = {
	capturedAt: string;
	itemCode: string;
	warehouse: string;
	availableQty: number;
	binActualQty: number;
	reservedQty: number;
};
type SaleStockEvidence = {
	sale: number;
	invoice: string;
	requestId: string;
	itemCode: string;
	ledgerState: string;
	docstatus: number;
	before: StockSnapshot;
	after: StockSnapshot;
	availableDelta: number;
	binActualDelta: number;
	reservedDelta: number;
	expectedAvailableDelta: number;
	deltaMatches: boolean;
};
type ShiftEvidence = {
	shift: number;
	mode: SearchMode;
	openingShift?: string;
	closingShift?: string;
	items: ItemFixture[];
	successfulSales: number;
	recoverableFailures: Array<Record<string, unknown>>;
	searchLatenciesMs: number[];
	signingLatenciesMs: number[];
	submissionLatenciesMs: number[];
	getItemsRequests: number;
	stockAfterEachSale: SaleStockEvidence[];
	stockAnomalies: Array<Record<string, unknown>>;
};
type TemporaryCashier = {
	user: string;
	pin: string;
};
type CatalogItem = {
	itemCode: string;
	actualQty: number;
};

test.skip(
	!ENABLED,
	"Set POSA_MULTISHIFT_ENDURANCE_E2E=1 to run the destructive 10-shift POS endurance test.",
);

// An eight-hour ceiling lets a 1,000-sale endurance test wait for authoritative
// background finalization and capture server stock after every sale while still
// failing a genuinely stranded ledger through the per-sale 90-second bound.
// evidence and Playwright traces on failure. Continuous video encoding is not
// diagnostic here and can itself saturate a test workstation, obscuring POS
// responsiveness instead of measuring it.
test.use({ video: "off" });

function positiveInteger(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asNumber(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function isBenignConsoleError(message: string) {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("remove_last_divider") ||
		(normalized.includes("offsetwidth") &&
			normalized.includes("shortcut.js")) ||
		normalized.includes("resizeobserver loop")
	);
}

function responseFor(method: string) {
	return (response: { url: () => string; status: () => number }) =>
		response.url().includes(method) && response.status() === 200;
}

function requestSearchValue(request: Request) {
	if (!request.url().includes(SEARCH_REQUEST_METHOD)) return null;
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

function percentile(values: number[], fraction: number) {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summary(values: number[]) {
	return {
		count: values.length,
		minMs: values.length ? Math.min(...values) : 0,
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		maxMs: values.length ? Math.max(...values) : 0,
	};
}

async function callFrappe<T = any>(
	page: Page,
	method: string,
	args: Record<string, unknown> = {},
) {
	return page.evaluate(
		async ({ callMethod, callArgs, timeoutMs }) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const request = (window as any).frappe.call({
					method: callMethod,
					args: callArgs,
				});
				const response = await Promise.race([
					Promise.resolve(request),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(
							() => reject(new Error(`${callMethod} exceeded ${timeoutMs}ms`)),
							timeoutMs,
						);
					}),
				]);
				return (response as any)?.message as T;
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		},
		{ callMethod: method, callArgs: args, timeoutMs: REQUEST_TIMEOUT_MS },
	) as Promise<T>;
}

async function waitForFinalSaleLedger(
	page: Page,
	requestId: string,
	invoiceName: string,
) {
	let latest: Record<string, any> | null = null;
	await expect
		.poll(
			async () => {
				const rows = await callFrappe<Array<Record<string, any>>>(
					page,
					"frappe.client.get_list",
					{
						doctype: "POS Invoice Submission Ledger",
						filters: [["client_request_id", "=", requestId]],
						fields: [
							"state",
							"invoice_name",
							"document_type",
							"error_message",
						],
						limit_page_length: 2,
					},
				);
				latest = rows[0] || null;
				if (latest?.state === "FAILED") {
					throw new Error(
						`Sale ${invoiceName} background finalization failed: ${latest.error_message || "unknown error"}`,
					);
				}
				return latest?.state || "MISSING";
			},
			{
				timeout: 90_000,
				intervals: [250, 500, 1000, 2000],
				message: `Sale ${invoiceName} did not reach POST_SUBMIT_DONE`,
			},
		)
		.toBe("POST_SUBMIT_DONE");

	const documentType = String(latest?.document_type || "POS Invoice");
	const resolvedInvoice = String(latest?.invoice_name || invoiceName);
	const document = await callFrappe<Record<string, any>>(
		page,
		"frappe.client.get_value",
		{
			doctype: documentType,
			filters: { name: resolvedInvoice },
			fieldname: ["name", "docstatus", "posa_client_request_id"],
		},
	);
	expect(String(document?.name || "")).toBe(resolvedInvoice);
	expect(String(document?.posa_client_request_id || "")).toBe(requestId);
	expect(asNumber(document?.docstatus)).toBe(1);
	return {
		state: String(latest?.state || ""),
		docstatus: asNumber(document?.docstatus),
	};
}

async function captureStockSnapshot(
	page: Page,
	itemCode: string,
	warehouse: string,
): Promise<StockSnapshot> {
	const availability = await callFrappe<
		Array<{ item_code: string; available_qty: number }>
	>(page, STOCK_METHOD, {
		items: [{ item_code: itemCode, warehouse }],
	});
	const bins = await callFrappe<Array<{ actual_qty?: number }>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "Bin",
			filters: [
				["item_code", "=", itemCode],
				["warehouse", "=", warehouse],
			],
			fields: ["actual_qty"],
			limit_page_length: 10,
		},
	);
	const availableQty = asNumber(availability[0]?.available_qty);
	const binActualQty = bins.reduce(
		(total, row) => total + asNumber(row.actual_qty),
		0,
	);
	return {
		capturedAt: new Date().toISOString(),
		itemCode,
		warehouse,
		availableQty,
		binActualQty,
		reservedQty: binActualQty - availableQty,
	};
}

function buildSaleStockEvidence(
	sale: number,
	result: SaleResult,
	ledger: { state: string; docstatus: number },
	before: StockSnapshot,
	after: StockSnapshot,
): SaleStockEvidence {
	const expectedAvailableDelta = -1;
	const availableDelta = after.availableQty - before.availableQty;
	return {
		sale,
		invoice: result.invoice,
		requestId: result.requestId,
		itemCode: result.itemCode,
		ledgerState: ledger.state,
		docstatus: ledger.docstatus,
		before,
		after,
		availableDelta,
		binActualDelta: after.binActualQty - before.binActualQty,
		reservedDelta: after.reservedQty - before.reservedQty,
		expectedAvailableDelta,
		deltaMatches: Math.abs(availableDelta - expectedAvailableDelta) <= 0.001,
	};
}

async function waitForFrappe(page: Page) {
	await page.waitForFunction(
		() => typeof (window as any).frappe?.call === "function",
		null,
		{ timeout: 60_000 },
	);
}

function normalizeProfileSettings(
	profile: Record<string, unknown>,
): ProfileSettings {
	return Object.fromEntries(
		PROFILE_FIELDS.map((field) => [field, asNumber(profile[field])]),
	) as ProfileSettings;
}

async function setProfileSettings(
	page: Page,
	profileName: string,
	overrides: Partial<ProfileSettings>,
) {
	await callFrappe(page, "frappe.client.set_value", {
		doctype: "POS Profile",
		name: profileName,
		fieldname: overrides,
	});
	await expect
		.poll(
			async () => {
				const profile = await callFrappe<Record<string, unknown>>(
					page,
					"frappe.client.get",
					{ doctype: "POS Profile", name: profileName },
				);
				return Object.fromEntries(
					Object.keys(overrides).map((field) => [
						field,
						asNumber(profile[field]),
					]),
				);
			},
			{ timeout: 30_000 },
		)
		.toEqual(
			Object.fromEntries(
				Object.entries(overrides).map(([field, value]) => [
					field,
					asNumber(value),
				]),
			),
		);
}

async function prepareHybridProfile(page: Page, profileName: string) {
	const profile = await callFrappe<Record<string, any>>(
		page,
		"frappe.client.get",
		{ doctype: "POS Profile", name: profileName },
	);
	const snapshot = normalizeProfileSettings(profile);
	await setProfileSettings(page, profileName, {
		posa_fast_counter_mode: 1,
		posa_hot_catalog_limit: 7000,
		posa_fast_counter_positive_stock_only: 1,
		posa_local_storage: 1,
		posa_force_server_items: 1,
		posa_use_server_cache: 1,
		posa_server_cache_duration: 1,
		pose_use_limit_search: 1,
		posa_search_limit: 100,
		posa_force_reload_items: 0,
		posa_smart_reload_mode: 1,
		// This is an explicitly opt-in, bounded POS policy. The endurance run
		// validates the durable offline prerequisite path without leaving it
		// enabled after the test restores the profile snapshot.
		posa_allow_offline_signed_cash_sales: 1,
		posa_offline_signed_sale_max_amount: 100_000,
		posa_offline_signed_sale_ttl_minutes: 1_440,
		posa_offline_signed_sale_ticket_batch_size: 5,
	});
	return { profile, snapshot };
}

async function provisionTemporaryCashier(page: Page, profileName: string) {
	const uniqueToken = `${Date.now()}-${randomInt(100000, 1000000)}`;
	const user = `posa-e2e-ten-shift-${uniqueToken}@retailmind.invalid`;
	const username = `posa_e2e_ten_shift_${uniqueToken}`;
	const pin = String(randomInt(100000, 1000000));
	await callFrappe(page, "frappe.client.insert", {
		doc: {
			doctype: "User",
			email: user,
			username,
			first_name: "POS E2E Endurance Cashier",
			enabled: 1,
			send_welcome_email: 0,
			posa_pos_pin: pin,
			roles: [{ role: "POS Awesome Supervisor" }],
		},
	});
	await callFrappe(page, "frappe.client.insert", {
		doc: {
			doctype: "POS Profile User",
			parent: profileName,
			parenttype: "POS Profile",
			parentfield: "applicable_for_users",
			user,
			default: 1,
		},
	});
	await callFrappe(
		page,
		"posawesome.posawesome.api.employees.lock_terminal",
		{ pos_profile: profileName },
	);
	const verified = await callFrappe<Record<string, any>>(
		page,
		"posawesome.posawesome.api.employees.verify_terminal_employee_pin",
		{ pos_profile: profileName, user, pin },
	);
	expect(verified?.terminal_state?.locked).toBe(false);
	expect(verified?.terminal_state?.active_cashier).toBe(user);
	return { user, pin } satisfies TemporaryCashier;
}

async function cleanupTemporaryCashier(
	page: Page,
	profileName: string,
	cashier: TemporaryCashier,
) {
	await callFrappe(
		page,
		"posawesome.posawesome.api.employees.lock_terminal",
		{ pos_profile: profileName },
	).catch(() => null);
	const assignments = await callFrappe<Array<{ name: string }>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "POS Profile User",
			filters: { parent: profileName, user: cashier.user },
			fields: ["name"],
			limit_page_length: 100,
		},
	).catch(() => []);
	for (const assignment of assignments) {
		await callFrappe(page, "frappe.client.delete", {
			doctype: "POS Profile User",
			name: assignment.name,
		}).catch(() => null);
	}
	await callFrappe(page, "frappe.client.delete", {
		doctype: "User",
		name: cashier.user,
	}).catch(async () => {
		await callFrappe(page, "frappe.client.set_value", {
			doctype: "User",
			name: cashier.user,
			fieldname: { enabled: 0, posa_pos_pin: "" },
		}).catch(() => null);
	});
}

async function waitForPosShell(page: Page) {
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	// A cold register with no open shift is ready when its opening-shift dialog
	// is visible. That blocking dialog intentionally hides the counter grid; an
	// already-open register instead exposes the grid directly.
	await expect
		.poll(
			async () =>
				(await page
					.getByTestId("opening-shift-dialog")
					.isVisible()
					.catch(() => false)) ||
				(await page
					.getByTestId("counter-grid-pos")
					.isVisible()
					.catch(() => false)),
			{ timeout: 90_000 },
		)
		.toBe(true);
}

async function waitForShiftState(page: Page) {
	const openingDialog = page.getByTestId("opening-shift-dialog");
	const counterGrid = page.getByTestId("counter-grid-pos");
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (await openingDialog.isVisible().catch(() => false)) return "opening";
		if (await counterGrid.isVisible().catch(() => false)) return "active";
		await page.waitForTimeout(250);
	}
	throw new Error("POS did not reach either the opening-shift dialog or active register state.");
}

async function startShiftThroughUi(page: Page, profileName: string) {
	const dialog = page.getByTestId("opening-shift-dialog");
	await expect(dialog).toBeVisible({ timeout: 90_000 });
	const amountInputs = dialog.locator(
		'[data-testid^="opening-shift-amount-"] input',
	);
	for (let index = 0; index < (await amountInputs.count()); index += 1) {
		await amountInputs.nth(index).fill("0");
	}
	const responsePromise = page.waitForResponse(
		responseFor("create_opening_voucher"),
		{ timeout: 45_000 },
	);
	await dialog.getByTestId("opening-shift-submit").click();
	const body = await (await responsePromise).json();
	const opening = body?.message?.pos_opening_shift || body?.message;
	expect(opening?.name).toBeTruthy();
	await expect(dialog).toBeHidden({ timeout: 45_000 });
	await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
		"data-pos-profile",
		profileName,
		{ timeout: 45_000 },
	);
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 45_000,
	});
	return String(opening.name);
}

async function closeShiftThroughUi(page: Page) {
	const preparationResponse = page.waitForResponse(
		responseFor("make_closing_shift_from_opening"),
		{ timeout: 45_000 },
	);
	await page.getByRole("button", { name: "Open actions menu" }).click();
	await page.locator('[data-test="quick-action-close-shift"]').click();
	const preparationBody = await (await preparationResponse).json();
	const prepared =
		preparationBody?.message?.closing_shift || preparationBody?.message;
	expect(prepared?.pos_opening_shift).toBeTruthy();
	expect(prepared?.payment_reconciliation?.length || 0).toBeGreaterThan(0);

	const dialog = page.locator(".closing-dialog-card:visible");
	await expect(
		dialog.getByRole("heading", { name: "Closing POS Shift" }),
	).toBeVisible({ timeout: 45_000 });
	const rows = dialog.locator(".reconciliation-section tbody tr");
	for (const payment of prepared.payment_reconciliation) {
		const row = rows.filter({ hasText: payment.mode_of_payment }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });
		await row
			.locator('input[type="number"]')
			.fill(String(asNumber(payment.expected_amount)));
	}
	const submitResponse = page.waitForResponse(
		responseFor("submit_closing_shift"),
		{ timeout: 45_000 },
	);
	await dialog.getByRole("button", { name: "Submit", exact: true }).click();
	const submitBody = await (await submitResponse).json();
	const closingName = String(submitBody?.message || "");
	expect(closingName).toBeTruthy();
	await expect(dialog).toBeHidden({ timeout: 45_000 });
	await expect(page.getByTestId("opening-shift-dialog")).toBeVisible({
		timeout: 90_000,
	});
	return closingName;
}

async function setForceServerSearchThroughUi(page: Page, enabled: boolean) {
	const entry = page.getByTestId("counter-grid-item-entry");
	await entry.focus();
	await entry.fill("AI167");
	await entry.press("Enter");
	const selector = page.locator(".items-selector-shell--counter-dialog");
	await expect(selector).toBeVisible({ timeout: 30_000 });
	const searchTools = selector.getByRole("button", { name: /search tools/i });
	const label = (await searchTools.getAttribute("aria-label")) || "";
	if (/show/i.test(label)) await searchTools.click();
	await selector.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page
		.locator("[role='dialog']")
		.filter({ hasText: "Item Selector Settings" })
		.last();
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	const forceServerControl = dialog.locator('input[type="checkbox"]').last();
	await expect(forceServerControl).toBeVisible();
	if ((await forceServerControl.isChecked()) !== enabled) {
		await forceServerControl.check({ force: true });
	}
	await dialog.getByRole("button", { name: "Save Settings" }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await page.keyboard.press("Escape");
	await expect(selector).toBeHidden({ timeout: 15_000 });
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 15_000,
	});
}

async function readActiveCatalogItems(page: Page) {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("posawesome_offline");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			if (
				!database.objectStoreNames.contains("item_catalog_state") ||
				!database.objectStoreNames.contains("item_catalog_rows")
			) {
				return [];
			}
			const readAll = (storeName: string) =>
				new Promise<any[]>((resolve, reject) => {
					const transaction = database.transaction(storeName, "readonly");
					const request = transaction.objectStore(storeName).getAll();
					request.onsuccess = () =>
						resolve(Array.isArray(request.result) ? request.result : []);
					request.onerror = () => reject(request.error);
				});
			const states = await readAll("item_catalog_state");
			const activeGeneration = new Map(
				states.map((state) => [
					String(state?.profile_scope || ""),
					String(state?.active_generation || ""),
				]),
			);
			const rows = await readAll("item_catalog_rows");
			return rows
				.filter(
					(row) =>
						activeGeneration.get(String(row?.profile_scope || "")) ===
						String(row?.catalog_generation || ""),
				)
				.map((row) => ({
					itemCode: String(row?.item_code || ""),
					actualQty: Number(row?.actual_qty || 0),
				}))
				.filter((row) => row.itemCode);
		} finally {
			database.close();
		}
	}) as Promise<CatalogItem[]>;
}

async function chooseServerItems(
	page: Page,
	warehouse: string,
	totalSales: number,
) {
	const availability = await callFrappe<
		Array<{ item_code: string; available_qty: number }>
	>(page, STOCK_METHOD, {
		items: CANDIDATE_ITEM_CODES.map((itemCode) => ({ item_code: itemCode, warehouse })),
	});
	const availableItems = availability
		.map((row) => ({
			itemCode: String(row.item_code || ""),
			availableQty: asNumber(row.available_qty),
		}))
		.filter((item) => item.itemCode);
	const itemMetadata = await callFrappe<
		Array<{ name?: string; item_name?: string }>
	>(page, "frappe.client.get_list", {
		doctype: "Item",
		filters: [["name", "in", availableItems.map((item) => item.itemCode)]],
		fields: ["name", "item_name"],
		limit_page_length: availableItems.length,
	});
	const itemNameByCode = new Map(
		itemMetadata.map((item) => [
			String(item.name || ""),
			String(item.item_name || "").trim(),
		]),
	);
	return chooseFixturePool(
		availableItems,
		totalSales,
		"Known positive-stock items cannot cover the server-search phase.",
	).map((item) => ({
		...item,
		searchQuery: resolveServerSearchQuery(
			item.itemCode,
			itemNameByCode.get(item.itemCode),
		),
	}));
}

async function chooseCachedItems(page: Page, totalSales: number) {
	await expect
		.poll(
			async () => {
				const items = await readActiveCatalogItems(page);
				return items.filter((item) => item.actualQty > 0).length;
			},
			{ timeout: 5 * 60_000, intervals: [1000, 2000, 5000] },
		)
		.toBeGreaterThan(0);
	return chooseFixturePool(
		await readActiveCatalogItems(page).then((items) =>
			items.map((item) => ({
			itemCode: item.itemCode,
			availableQty: item.actualQty,
			})),
		),
		totalSales,
		"The local browser cache does not contain enough positive stock for the cached-search phase.",
	).map((item) => ({ ...item, searchQuery: item.itemCode }));
}

function resolveServerSearchQuery(itemCode: string, itemName?: string) {
	const normalizedName = String(itemName || "").trim();
	if (normalizedName && normalizedName.toLowerCase() !== itemCode.toLowerCase()) {
		return normalizedName;
	}
	// All fixture codes are at least four characters. A non-exact prefix still
	// targets the server search path if a legacy item name is unavailable.
	return itemCode.slice(0, Math.max(3, itemCode.length - 1));
}

function chooseFixturePool(
	candidates: AvailableItem[],
	totalSales: number,
	errorMessage: string,
) {
	const sorted = candidates
		.filter((item) => item.itemCode && item.availableQty > 0)
		.sort((left, right) => right.availableQty - left.availableQty)
		.slice(0, 10);
	for (let size = sorted.length; size >= 1; size -= 1) {
		const requiredPerItem = Math.ceil(totalSales / size) + 5;
		const pool = sorted.slice(0, size);
		if (pool.every((item) => item.availableQty >= requiredPerItem)) {
			return pool;
		}
	}
	throw new Error(errorMessage);
}

async function addItemByKeyboard(
	page: Page,
	itemCode: string,
	searchQuery: string,
) {
	const requests: Request[] = [];
	const listener = (request: Request) => {
		const value = requestSearchValue(request);
		if (value?.trim().toLowerCase() === searchQuery.toLowerCase()) {
			requests.push(request);
		}
	};
	page.on("request", listener);
	try {
		const entry = page.getByTestId("counter-grid-item-entry");
		await entry.focus();
		await entry.fill(searchQuery);
		const startedAt = Date.now();
		await entry.press("Enter");
		const selector = page.locator(".items-selector-shell--counter-dialog");
		await expect(selector).toHaveAttribute("data-search-ready-query", searchQuery, {
			timeout: 30_000,
		});
		await expect(selector).toHaveAttribute("data-search-pending", "false", {
			timeout: 30_000,
		});
		const result = page.getByTestId(`pos-item-row-${itemCode}`).first();
		await expect(result).toBeVisible({ timeout: 30_000 });
		await expect(result).toHaveAttribute("aria-selected", "true");
		await page.getByTestId("pos-item-search").locator("input").press("Enter");
		await expect(page.getByTestId(`cart-row-${itemCode}`).first()).toBeVisible({
			timeout: 30_000,
		});
		return {
			searchLatencyMs: Date.now() - startedAt,
			serverRequests: requests.length,
		};
	} finally {
		page.off("request", listener);
	}
}

async function submitSignedSale(page: Page, pin: string) {
	const eventIndex = await page.evaluate(
		() => (window as any).__posMultishiftResponses.length,
	);
	const startedAt = Date.now();
	await page.keyboard.press("Alt+X");
	const dialog = page.getByTestId("cashier-sale-signing-dialog");
	await expect(dialog).toBeVisible({ timeout: 30_000 });
	const signingLatencyMs = Date.now() - startedAt;
	await expect(page.locator('[data-testid="payment-root"]:visible')).toHaveCount(0);
	await expect(page.locator("[role='dialog']:visible")).toHaveCount(1);
	const pinInput = dialog.getByTestId("cashier-sale-pin-input").locator("input");
	await expect(pinInput).toBeFocused({ timeout: 10_000 });
	await pinInput.fill(pin);
	await pinInput.press("Enter");
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as any).__posMultishiftResponses.length,
				),
			{ timeout: 90_000 },
		)
		.toBeGreaterThan(eventIndex);
	const response = await page.evaluate(
		() => (window as any).__posMultishiftResponses.at(-1),
	);
	expect(response?.requestId).toBeTruthy();
	expect(response?.invoice).toBeTruthy();
	await expect(page.getByTestId("submission-recovery-banner")).toHaveCount(0);
	await expect(dialog).toBeHidden({ timeout: 30_000 });
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 30_000,
	});
	return {
		invoice: String(response.invoice),
		requestId: String(response.requestId),
		signingLatencyMs,
		submissionLatencyMs: Date.now() - startedAt,
	};
}

async function recoverAfterFailedSale(page: Page) {
	if (
		await page
			.getByTestId("submission-recovery-banner")
			.isVisible()
			.catch(() => false)
	) {
		return false;
	}
	const signingDialog = page.getByTestId("cashier-sale-signing-dialog");
	if (await signingDialog.isVisible().catch(() => false)) {
		await signingDialog.getByTestId("cashier-sale-cancel").click().catch(() => null);
	}
	if (
		await page
			.locator('[data-testid="payment-root"]:visible')
			.count()
			.catch(() => 0)
	) {
		await page.keyboard.press("Escape").catch(() => null);
	}
	const cartRows = page.locator('[data-testid^="cart-row-"]');
	if ((await cartRows.count()) > 0) {
		await page.getByTestId("invoice-action-cancel-sale").click();
		await page
			.getByRole("button", { name: "Yes, Cancel sale" })
			.click();
	}
	const ready = await page
		.getByTestId("counter-grid-item-entry")
		.isVisible({ timeout: 30_000 })
		.catch(() => false);
	return ready;
}

async function attachEvidence(
	testInfo: TestInfo,
	evidence: Record<string, unknown>,
) {
	const path = testInfo.outputPath("pos-multishift-endurance-report.json");
	await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	await testInfo.attach("pos-multishift-endurance-report", {
		path,
		contentType: "application/json",
	});
}

test("runs ten UI-managed same-tab POS shifts with server and browser-cache search", async ({
	page,
}, testInfo) => {
	test.setTimeout(8 * 60 * 60_000);
	await page.setViewportSize({ width: 1366, height: 768 });
	const startedAt = new Date().toISOString();
	const evidence: Record<string, any> = {
		startedAt,
		profile: POS_PROFILE,
		requestedShifts: SHIFT_COUNT,
		requestedSalesPerShift: SALES_PER_SHIFT,
		browserRefreshesAfterBootstrap: 0,
		preexistingShiftClosed: false,
		shifts: [] as ShiftEvidence[],
		globalErrors: [] as string[],
		mainFrameNavigations: [] as string[],
		cleanupErrors: [] as string[],
		stockAnomalies: [] as Array<Record<string, unknown>>,
	};
	let profileSnapshot: ProfileSettings | null = null;
	let cashier: TemporaryCashier | null = null;
	let invoiceDoctype = "POS Invoice";
	const invoiceNames: string[] = [];
	const navigationListener = (frame: { parentFrame: () => unknown; url: () => string }) => {
		if (!frame.parentFrame()) evidence.mainFrameNavigations.push(frame.url());
	};
	const pageErrorListener = (error: Error) => {
		const message = String(error?.message || error);
		if (!isBenignConsoleError(message)) evidence.globalErrors.push(`pageerror: ${message}`);
	};
	const consoleListener = (message: { type: () => string; text: () => string }) => {
		if (message.type() !== "error") return;
		const text = message.text();
		if (!isBenignConsoleError(text)) evidence.globalErrors.push(`console.error: ${text}`);
	};
	page.on("pageerror", pageErrorListener);
	page.on("console", consoleListener);
	page.on("dialog", async (dialog) => {
		await dialog.accept().catch(() => null);
	});

	try {
		await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
		if (/\/login/.test(page.url())) {
			throw new Error("POS multishift E2E requires POSA_SMOKE_SID.");
		}
		await waitForFrappe(page);
		// Cold-start the POS before making any terminal/profile mutations. Locking
		// or provisioning a terminal during bootstrap can intentionally invalidate
		// its in-flight readiness cycle; that is a harness interaction, not a
		// cash-register shift transition. No reload is necessary: the server-side
		// verification below establishes the temporary cashier for the signed-sale
		// API while the already-ready POS stays on its one test tab.
		await waitForPosShell(page);
		const preparedProfile = await prepareHybridProfile(page, POS_PROFILE);
		const warehouse = String(
			preparedProfile.profile.warehouse || "Main Store - MP",
		);
		profileSnapshot = preparedProfile.snapshot;
		invoiceDoctype = Number(
			preparedProfile.profile.create_pos_invoice_instead_of_sales_invoice || 0,
		)
			? "POS Invoice"
			: "Sales Invoice";
		cashier = await provisionTemporaryCashier(page, POS_PROFILE);

		await expect(page.locator('[data-test="terminal-lock-dialog"]')).toBeHidden({
			timeout: 30_000,
		});
		await page.evaluate(() => {
			(window as any).__posMultishiftResponses = [];
			window.addEventListener("posa:invoice-submit-response", (event: Event) => {
				(window as any).__posMultishiftResponses.push(
					(event as CustomEvent).detail,
				);
			});
		});
		page.on("framenavigated", navigationListener);

		if ((await waitForShiftState(page)) === "active") {
			evidence.preexistingShiftClosed = true;
			await closeShiftThroughUi(page);
		}

		const serverItems = await chooseServerItems(
			page,
			warehouse,
			Math.ceil(SHIFT_COUNT / 2) * SALES_PER_SHIFT,
		);

		for (let shiftIndex = 0; shiftIndex < SHIFT_COUNT; shiftIndex += 1) {
			const mode: SearchMode = shiftIndex < Math.ceil(SHIFT_COUNT / 2)
				? "server"
				: "browser-cache";
			const shiftEvidence: ShiftEvidence = {
				shift: shiftIndex + 1,
				mode,
				items: [],
				successfulSales: 0,
				recoverableFailures: [],
				searchLatenciesMs: [],
				signingLatenciesMs: [],
				submissionLatenciesMs: [],
				getItemsRequests: 0,
				stockAfterEachSale: [],
				stockAnomalies: [],
			};
			evidence.shifts.push(shiftEvidence);
			shiftEvidence.openingShift = await startShiftThroughUi(page, POS_PROFILE);

			if (mode === "server") {
				await setForceServerSearchThroughUi(page, true);
				shiftEvidence.items = serverItems;
			} else {
				await setForceServerSearchThroughUi(page, false);
				shiftEvidence.items = await chooseCachedItems(page, SALES_PER_SHIFT);
				expect(
					shiftEvidence.items.length,
					"The local browser cache must contain positive-stock items for cached sales.",
				).toBeGreaterThan(0);
			}

			for (let saleIndex = 0; saleIndex < SALES_PER_SHIFT; saleIndex += 1) {
				const item = shiftEvidence.items[saleIndex % shiftEvidence.items.length];
				try {
					const stockBefore = await captureStockSnapshot(
						page,
						item.itemCode,
						warehouse,
					);
					const search = await addItemByKeyboard(
						page,
						item.itemCode,
						item.searchQuery,
					);
					const submitted = await submitSignedSale(page, cashier.pin);
					const result: SaleResult = {
						...submitted,
						itemCode: item.itemCode,
						...search,
					};
					if (mode === "server") {
						expect(
							result.serverRequests,
							`Server-search sale ${shiftIndex + 1}.${saleIndex + 1} must call get_items.`,
						).toBeGreaterThan(0);
					} else {
						expect(
							result.serverRequests,
							`Cached exact-code sale ${shiftIndex + 1}.${saleIndex + 1} must not call get_items.`,
						).toBe(0);
					}
					invoiceNames.push(result.invoice);
					shiftEvidence.successfulSales += 1;
					shiftEvidence.getItemsRequests += result.serverRequests;
					shiftEvidence.searchLatenciesMs.push(result.searchLatencyMs);
					shiftEvidence.signingLatenciesMs.push(result.signingLatencyMs);
					shiftEvidence.submissionLatenciesMs.push(result.submissionLatencyMs);
					try {
						const ledger = await waitForFinalSaleLedger(
							page,
							result.requestId,
							result.invoice,
						);
						const stockAfter = await captureStockSnapshot(
							page,
							item.itemCode,
							warehouse,
						);
						const stockEvidence = buildSaleStockEvidence(
							saleIndex + 1,
							result,
							ledger,
							stockBefore,
							stockAfter,
						);
						shiftEvidence.stockAfterEachSale.push(stockEvidence);
						if (!stockEvidence.deltaMatches) {
							const anomaly = {
								shift: shiftIndex + 1,
								sale: saleIndex + 1,
								invoice: result.invoice,
								itemCode: item.itemCode,
								expectedAvailableDelta:
									stockEvidence.expectedAvailableDelta,
								actualAvailableDelta: stockEvidence.availableDelta,
							};
							shiftEvidence.stockAnomalies.push(anomaly);
							evidence.stockAnomalies.push(anomaly);
						}
					} catch (stockError) {
						const anomaly = {
							shift: shiftIndex + 1,
							sale: saleIndex + 1,
							invoice: result.invoice,
							itemCode: item.itemCode,
							error: String(
								(stockError as Error)?.message || stockError,
							),
						};
						shiftEvidence.stockAnomalies.push(anomaly);
						evidence.stockAnomalies.push(anomaly);
					}
				} catch (error) {
					const recoverable = await recoverAfterFailedSale(page);
					const failure = {
						sale: saleIndex + 1,
						itemCode: item.itemCode,
						recovered: recoverable,
						message: String((error as Error)?.message || error).slice(0, 2000),
					};
					shiftEvidence.recoverableFailures.push(failure);
					if (!recoverable) {
						throw new Error(
							`Unable to continue safely after shift ${shiftIndex + 1}, sale ${saleIndex + 1}: ${failure.message}`,
						);
					}
				}
				if ((saleIndex + 1) % 10 === 0 || saleIndex + 1 === SALES_PER_SHIFT) {
					console.log(
						`[pos-multishift] shift ${shiftIndex + 1}/${SHIFT_COUNT} ${mode} ${saleIndex + 1}/${SALES_PER_SHIFT}`,
					);
				}
			}
			shiftEvidence.closingShift = await closeShiftThroughUi(page);
		}

		const submittedInvoices = [] as Array<Record<string, any>>;
		for (let offset = 0; offset < invoiceNames.length; offset += 100) {
			const rows = await callFrappe<Array<Record<string, any>>>(
				page,
				"frappe.client.get_list",
				{
					doctype: invoiceDoctype,
					filters: [
						["name", "in", invoiceNames.slice(offset, offset + 100)],
						["docstatus", "=", 1],
					],
					fields: ["name", "docstatus", "posa_pos_opening_shift", "posa_cashier"],
					limit_page_length: 100,
				},
			);
			submittedInvoices.push(...rows);
		}
		evidence.invoiceVerification = {
			doctype: invoiceDoctype,
			responseInvoices: invoiceNames.length,
			uniqueResponseInvoices: new Set(invoiceNames).size,
			serverSubmittedInvoices: submittedInvoices.length,
			unexpectedCashiers: submittedInvoices.filter(
				(row) => row.posa_cashier !== cashier?.user,
			).length,
		};
		evidence.latency = {
			search: summary(evidence.shifts.flatMap((shift: ShiftEvidence) => shift.searchLatenciesMs)),
			signing: summary(evidence.shifts.flatMap((shift: ShiftEvidence) => shift.signingLatenciesMs)),
			submission: summary(
				evidence.shifts.flatMap((shift: ShiftEvidence) => shift.submissionLatenciesMs),
			),
		};
		evidence.finishedAt = new Date().toISOString();

		expect(invoiceNames).toHaveLength(SHIFT_COUNT * SALES_PER_SHIFT);
		expect(new Set(invoiceNames).size).toBe(invoiceNames.length);
		expect(submittedInvoices).toHaveLength(invoiceNames.length);
		expect(
			submittedInvoices.every((row) => row.posa_cashier === cashier?.user),
		).toBe(true);
		expect(
			evidence.shifts.flatMap((shift: ShiftEvidence) => shift.recoverableFailures),
		"All recoverable faults are reported after the run; a clean certification requires none.",
	).toHaveLength(0);
		expect(
			evidence.stockAnomalies,
			"Every completed sale must finalize and reduce reservation-aware available stock by one unit.",
		).toHaveLength(0);
		expect(evidence.globalErrors, "Unexpected browser errors are not release-ready.").toHaveLength(0);
		expect(
			evidence.mainFrameNavigations,
		"No page refresh or navigation is permitted after POS bootstrap.",
	).toHaveLength(0);
	} finally {
		page.off("framenavigated", navigationListener);
		page.off("pageerror", pageErrorListener);
		page.off("console", consoleListener);
		if (cashier) {
			await cleanupTemporaryCashier(page, POS_PROFILE, cashier).catch((error) => {
				evidence.cleanupErrors.push(
					`cashier cleanup: ${String((error as Error)?.message || error)}`,
				);
			});
		}
		if (profileSnapshot) {
			await setProfileSettings(page, POS_PROFILE, profileSnapshot).catch((error) => {
				evidence.cleanupErrors.push(
					`profile restore: ${String((error as Error)?.message || error)}`,
				);
			});
		}
		evidence.finishedAt ||= new Date().toISOString();
		await attachEvidence(testInfo, evidence);
	}
});
