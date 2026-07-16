import { expect, test } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_COUNTER_GRID_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";

test.skip(
	!ENABLED,
	"Set POSA_COUNTER_GRID_E2E=1 to run Counter Grid E2E tests.",
);

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page);
});

test("continues online when browser storage is too large to open safely", async ({
	page,
}) => {
	const browserDiagnostics: string[] = [];
	page.on("console", (message) => {
		browserDiagnostics.push(message.text());
	});

	await page.addInitScript(() => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: {
				estimate: async () => ({
					quota: 20 * 1024 * 1024 * 1024,
					usage: 2 * 1024 * 1024 * 1024,
				}),
			},
		});
	});

	await page.setViewportSize({ width: 1366, height: 768 });
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Degraded-storage E2E requires POSA_SMOKE_SID or login credentials.",
		);
	}
	const storageEstimate = await page.evaluate(() =>
		navigator.storage.estimate(),
	);
	expect(storageEstimate.usage).toBe(2 * 1024 * 1024 * 1024);

	await ensureAuthoritativeTerminalUnlock(page);
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 30_000,
	});
	await expect
		.poll(() =>
			browserDiagnostics.some((message) =>
				message.includes(
					"POS browser storage is deferred; continuing in online server-only mode",
				),
			),
		)
		.toBe(true);
});
