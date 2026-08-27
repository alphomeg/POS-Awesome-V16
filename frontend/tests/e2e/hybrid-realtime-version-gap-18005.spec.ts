import { execFileSync } from "node:child_process";

import { expect, test, type Page, type Request } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_HYBRID_REALTIME_GAP_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const PROFILE =
	process.env.POSA_COUNTER_GRID_POS_PROFILE || "MedPlus POS 1 - Supervisor";
const ITEM_CODE = process.env.POSA_HYBRID_VERIFIED_ITEM || "AI167";
const WAREHOUSE = process.env.POSA_HYBRID_WAREHOUSE || "Main Store - MP";
const COMPANY = process.env.POSA_HYBRID_COMPANY || "MedPlus Pharmacy";
const BACKEND_CONTAINER =
	process.env.POSA_HYBRID_BACKEND_CONTAINER ||
	"retailmind-hybrid-search-18005-backend-1";

test.skip(
	!ENABLED,
	"Set POSA_HYBRID_REALTIME_GAP_E2E=1 to run the local realtime gap acceptance check.",
);

function isMethodRequest(request: Request, method: string) {
	return request.url().includes(method);
}

function executeBench(
	method: string,
	options: { args?: unknown[]; kwargs?: unknown } = {},
) {
	const commandArgs = [
		"exec",
		BACKEND_CONTAINER,
		"bench",
		"--site",
		"retailmind.local",
		"execute",
		method,
	];
	if (options.args) {
		commandArgs.push("--args", JSON.stringify(options.args));
	}
	if (options.kwargs) {
		commandArgs.push("--kwargs", JSON.stringify(options.kwargs));
	}
	const output = execFileSync("docker", commandArgs, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	return output ? JSON.parse(output) : null;
}

async function startZeroBalanceShiftIfNeeded(page: Page) {
	const openingDialog = page.getByTestId("opening-shift-dialog");
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
	await responsePromise;
	await expect(openingDialog).toBeHidden({ timeout: 45_000 });
}

async function prepareUnlockedPos(page: Page) {
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Realtime gap acceptance requires POSA_SMOKE_SID.");
	}
	await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
		"data-pos-profile",
		PROFILE,
		{ timeout: 45_000 },
	);
	await ensureAuthoritativeTerminalUnlock(page);
	await expect(page.locator('[data-test="terminal-lock-dialog"]')).toBeHidden(
		{
			timeout: 30_000,
		},
	);
	await startZeroBalanceShiftIfNeeded(page);
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
}

test("a server-published stock version gap forces a fresh live snapshot without blocking the POS", async ({
	page,
}) => {
	test.setTimeout(5 * 60_000);
	const liveRequests: Request[] = [];
	page.on("request", (request) => {
		if (isMethodRequest(request, "get_live_item_state")) {
			liveRequests.push(request);
		}
	});

	await prepareUnlockedPos(page);
	const entry = page.getByTestId("counter-grid-item-entry");
	await expect(entry).toBeFocused({ timeout: 30_000 });
	await entry.fill(ITEM_CODE);
	await entry.press("Enter");
	const searchSurface = page.locator(".items-selector-shell--counter-dialog");
	const itemRow = searchSurface
		.locator(`[data-item-code="${ITEM_CODE}"]`)
		.first();
	await expect(itemRow).toBeVisible({ timeout: 15_000 });
	await expect(
		itemRow.locator(
			'.live-state-verified[title="Live stock and price verified"]',
		),
	).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => liveRequests.length).toBeGreaterThan(0);
	await page.evaluate(() => {
		(window as any).__posaHybridGapEvent = null;
		(window as any).__posaStockHandlerCount =
			(window as any).frappe.realtime.socket?._callbacks?.[
				"$posa_stock_changed"
			]?.length || 0;
		(window as any).frappe.realtime.on(
			"posa_stock_changed",
			(payload: any) => {
				if (payload?.source_doctype === "Hybrid Verified E2E") {
					(window as any).__posaHybridGapEvent = payload;
				}
			},
		);
	});
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__posaStockHandlerCount),
		)
		.toBeGreaterThan(0);

	const liveState = await page.evaluate(
		async ({ profile, itemCode }) => {
			const response = await (window as any).frappe.call({
				method: "posawesome.posawesome.api.items.get_live_item_state",
				args: { pos_profile: profile, item_codes: [itemCode] },
			});
			return response?.message;
		},
		{ profile: PROFILE, itemCode: ITEM_CODE },
	);
	const actualQty = Number(liveState?.items?.[0]?.actual_qty);
	expect(Number.isFinite(actualQty)).toBe(true);

	const beforeGapRequestCount = liveRequests.length;
	// Delete only the derived Redis ordering tokens. This models a Redis restart
	// while preserving all ERPNext stock. The next token has a new epoch, which
	// is the deterministic realtime reconnect/version-gap recovery path.
	executeBench("frappe.cache.delete_value", {
		args: ["posa:stock-version:epoch"],
	});
	executeBench("frappe.cache.delete_value", {
		args: [`posa:stock-version:warehouse:${WAREHOUSE}`],
	});
	const version = executeBench(
		"posawesome.posawesome.stock_version.increment_stock_version",
		{ args: [WAREHOUSE] },
	);
	expect(typeof version?.epoch).toBe("string");
	expect(Number.isFinite(Number(version?.version))).toBe(true);

	executeBench("frappe.publish_realtime", {
		kwargs: {
			event: "posa_stock_changed",
			message: {
				items: [
					{
						item_code: ITEM_CODE,
						warehouse: WAREHOUSE,
						company: COMPANY,
						actual_qty: actualQty,
						stock_version: version,
					},
				],
				item_codes: [ITEM_CODE],
				warehouses: [WAREHOUSE],
				companies: [COMPANY],
				stock_versions: { [WAREHOUSE]: version },
				source_doctype: "Hybrid Verified E2E",
			},
			user: "Administrator",
		},
	});

	await expect
		.poll(() => page.evaluate(() => (window as any).__posaHybridGapEvent), {
			timeout: 15_000,
		})
		.toMatchObject({
			source_doctype: "Hybrid Verified E2E",
			stock_versions: { [WAREHOUSE]: version },
		});
	await expect
		.poll(() => liveRequests.length, { timeout: 25_000 })
		.toBeGreaterThan(beforeGapRequestCount);
	await expect(
		itemRow.locator(
			'.live-state-verified[title="Live stock and price verified"]',
		),
	).toBeVisible({ timeout: 25_000 });

	await page.keyboard.press("Escape");
	await expect(searchSurface).toBeHidden({ timeout: 15_000 });
	await expect(entry).toBeFocused({ timeout: 15_000 });
});

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page).catch(() => undefined);
});
