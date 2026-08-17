import { expect, test, type Page, type Request } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_HYBRID_VERIFIED_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const PROFILE =
	process.env.POSA_COUNTER_GRID_POS_PROFILE || "MedPlus POS 1 - Supervisor";
const ITEM_CODE = process.env.POSA_HYBRID_VERIFIED_ITEM || "AI167";

test.skip(
	!ENABLED,
	"Set POSA_HYBRID_VERIFIED_E2E=1 to run Hybrid Verified live acceptance.",
);

function isMethodRequest(request: Request, method: string) {
	return request.url().includes(method);
}

function requestSearchValue(request: Request) {
	const params = new URLSearchParams(request.postData() || "");
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

async function startZeroBalanceShiftIfNeeded(page: Page) {
	const openingDialog = page.getByTestId("opening-shift-dialog");
	const counterGrid = page.getByTestId("counter-grid-pos");
	await expect
		.poll(
			async () =>
				(await openingDialog.isVisible().catch(() => false)) ||
				(await counterGrid.isVisible().catch(() => false)),
			{ timeout: 90_000 },
		)
		.toBe(true);
	if (!(await openingDialog.isVisible().catch(() => false))) return;

	const amountInputs = openingDialog.locator(
		'[data-testid^="opening-shift-amount-"] input',
	);
	for (let index = 0; index < (await amountInputs.count()); index += 1) {
		await amountInputs.nth(index).fill("0");
	}
	const responsePromise = page.waitForResponse(
		(response) =>
			isMethodRequest(response.request(), "create_opening_voucher") &&
			response.status() === 200,
		{ timeout: 45_000 },
	);
	await openingDialog.getByTestId("opening-shift-submit").click();
	const response = await responsePromise;
	const body = await response.json();
	expect(
		body?.message?.pos_opening_shift?.name || body?.message?.name,
	).toBeTruthy();
	await expect(openingDialog).toBeHidden({ timeout: 45_000 });
}

async function readProfileFlags(page: Page) {
	return page.evaluate(async (profileName) => {
		const response = await (window as any).frappe.call({
			method: "frappe.client.get",
			args: { doctype: "POS Profile", name: profileName },
		});
		const profile = response?.message || {};
		return {
			fastCounter: Number(profile.posa_fast_counter_mode || 0),
			localStorage: Number(profile.posa_local_storage || 0),
			forceServer: Number(profile.posa_force_server_items || 0),
		};
	}, PROFILE);
}

async function preparePos(page: Page) {
	const hotCatalogueReady = page.waitForResponse(
		(response) =>
			isMethodRequest(response.request(), "get_hot_items") &&
			response.status() === 200,
		{ timeout: 3 * 60_000 },
	);
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Hybrid Verified acceptance requires POSA_SMOKE_SID.");
	}
	await startZeroBalanceShiftIfNeeded(page);
	await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
		"data-pos-profile",
		PROFILE,
		{ timeout: 45_000 },
	);
	await ensureAuthoritativeTerminalUnlock(page);
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	// A brand-new browser has no local candidates. Wait for the purpose-built
	// hot catalogue, not the much larger background/offline catalogue. The
	// terminal must already be unlocked so this readiness cycle is not reloaded.
	await hotCatalogueReady;
}

test("local candidate is immediate, then live stock and price are verified in place", async ({
	page,
}) => {
	test.setTimeout(8 * 60_000);
	const liveRequests: Request[] = [];
	const serverSearchRequests: Request[] = [];
	page.on("request", (request) => {
		if (isMethodRequest(request, "get_live_item_state")) {
			liveRequests.push(request);
		}
		if (
			isMethodRequest(
				request,
				"posawesome.posawesome.api.items.get_items",
			) &&
			requestSearchValue(request).trim().toLowerCase() ===
				ITEM_CODE.toLowerCase()
		) {
			serverSearchRequests.push(request);
		}
	});

	await preparePos(page);

	expect(await readProfileFlags(page)).toEqual({
		fastCounter: 1,
		localStorage: 1,
		forceServer: 0,
	});

	const entry = page.getByTestId("counter-grid-item-entry");
	await expect(entry).toBeFocused({ timeout: 30_000 });
	await entry.fill(ITEM_CODE);
	const startedAt = performance.now();
	await entry.press("Enter");
	const searchSurface = page.locator(".items-selector-shell--counter-dialog");
	const itemRow = searchSurface
		.locator(`[data-item-code="${ITEM_CODE}"]`)
		.first();
	await expect(itemRow).toBeVisible({ timeout: 10_000 });
	const candidateLatencyMs = performance.now() - startedAt;
	await expect(searchSurface).toHaveAttribute(
		"data-search-ready-query",
		ITEM_CODE,
		{ timeout: 10_000 },
	);
	const firstVisibleCode = await searchSurface
		.locator("[data-item-code]")
		.first()
		.getAttribute("data-item-code");

	await expect(
		itemRow.locator(
			'.live-state-verified[title="Live stock and price verified"]',
		),
	).toBeVisible({ timeout: 15_000 });
	await expect
		.poll(() => liveRequests.length, { timeout: 15_000 })
		.toBeGreaterThan(0);
	expect(
		await searchSurface
			.locator("[data-item-code]")
			.first()
			.getAttribute("data-item-code"),
	).toBe(firstVisibleCode);
	expect(candidateLatencyMs).toBeLessThan(2_000);

	await page.getByTestId(`pos-item-search`).locator("input").press("Enter");
	await expect(page.getByTestId(`cart-row-${ITEM_CODE}`).first()).toBeVisible(
		{
			timeout: 20_000,
		},
	);
	expect(liveRequests.length).toBeGreaterThan(0);
	expect(serverSearchRequests.length).toBeLessThanOrEqual(1);
});

test("warmed exact-code search remains immediate offline and is labelled last known", async ({
	context,
	page,
}) => {
	test.setTimeout(8 * 60_000);
	let liveRequestCount = 0;
	page.on("request", (request) => {
		if (isMethodRequest(request, "get_live_item_state")) {
			liveRequestCount += 1;
		}
	});
	await preparePos(page);

	const entry = page.getByTestId("counter-grid-item-entry");
	await expect(entry).toBeFocused({ timeout: 30_000 });
	await entry.fill(ITEM_CODE);
	await entry.press("Enter");
	let searchSurface = page.locator(".items-selector-shell--counter-dialog");
	await expect(
		searchSurface.locator(`[data-item-code="${ITEM_CODE}"]`).first(),
	).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press("Escape");
	await expect(searchSurface).toBeHidden({ timeout: 15_000 });
	await expect(entry).toBeFocused({ timeout: 15_000 });

	await context.setOffline(true);
	const requestsBeforeOfflineSearch = liveRequestCount;
	await entry.fill(ITEM_CODE);
	const startedAt = performance.now();
	await entry.press("Enter");
	searchSurface = page.locator(".items-selector-shell--counter-dialog");
	const offlineRow = searchSurface
		.locator(`[data-item-code="${ITEM_CODE}"]`)
		.first();
	await expect(offlineRow).toBeVisible({ timeout: 10_000 });
	expect(performance.now() - startedAt).toBeLessThan(2_000);
	await expect(
		offlineRow.locator(
			'.live-state-last_known[title="Showing last known stock and price"]',
		),
	).toBeVisible({ timeout: 10_000 });
	expect(liveRequestCount).toBe(requestsBeforeOfflineSearch);
	await context.setOffline(false);
});

test.afterEach(async ({ context, page }) => {
	await context.setOffline(false).catch(() => undefined);
	await cleanupProvisionedTerminalCashier(page).catch(() => undefined);
});
