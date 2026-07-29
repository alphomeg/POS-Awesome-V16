import { expect, test } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_TERMINAL_RELOAD_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const READINESS_TIMEOUT_MS = Number(
	process.env.POSA_TERMINAL_RELOAD_TIMEOUT_MS || 120_000,
);

test.skip(
	!ENABLED,
	"Set POSA_TERMINAL_RELOAD_E2E=1 to run the terminal reload readiness test.",
);

async function waitForReady(page: import("@playwright/test").Page) {
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: READINESS_TIMEOUT_MS,
	});
	try {
		await expect(page.locator(".loading-overlay")).toHaveCount(0, {
			timeout: READINESS_TIMEOUT_MS,
		});
	} catch (error) {
		const diagnostics = await page.evaluate(() => {
			return {
				overlayText:
					document
						.querySelector(".loading-overlay")
						?.textContent?.trim() || "",
				applicationState: Object.fromEntries(
					Array.from(
						document.querySelector(".posapp")?.attributes || [],
					)
						.filter((attribute) =>
							attribute.name.startsWith("data-"),
						)
						.map((attribute) => [attribute.name, attribute.value]),
				),
				navbarProgress:
					document
						.querySelector('[data-test="pos-navbar"]')
						?.getAttribute("data-loading-progress") || null,
			};
		});
		throw new Error(
			`POS readiness did not settle: ${JSON.stringify(diagnostics)}\n${String(error)}`,
		);
	}
	await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
		"data-pos-profile",
		/\S+/,
		{ timeout: READINESS_TIMEOUT_MS },
	);
	const application = page.locator(".posapp");
	await expect(application).toHaveAttribute(
		"data-bootstrap-phase",
		"settled",
	);
	await expect(application).toHaveAttribute("data-bootstrap-settled", "1");
	await expect(application).toHaveAttribute(
		"data-loading-source-init",
		"100",
	);
	await expect(application).toHaveAttribute(
		"data-loading-source-items",
		"100",
	);
	await expect(application).toHaveAttribute(
		"data-loading-source-customers",
		"100",
	);
}

test("terminal activation and consecutive reloads restore bootstrap readiness", async ({
	page,
}) => {
	test.setTimeout(6 * 60_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(`console.error: ${message.text()}`);
		}
	});

	const coldStartedAt = Date.now();
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Terminal reload E2E requires POSA_SMOKE_SID.");
	}
	await waitForReady(page);
	const coldLatencyMs = Date.now() - coldStartedAt;

	const activationStartedAt = Date.now();
	await ensureAuthoritativeTerminalUnlock(page);
	await waitForReady(page);
	const activationReloadLatencyMs = Date.now() - activationStartedAt;

	const steadyReloadStartedAt = Date.now();
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitForReady(page);
	const steadyReloadLatencyMs = Date.now() - steadyReloadStartedAt;

	console.log(
		`[terminal-reload] cold=${coldLatencyMs}ms activation_reload=${activationReloadLatencyMs}ms steady_reload=${steadyReloadLatencyMs}ms`,
	);
	expect(errors, errors.join("\n")).toHaveLength(0);
});

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page);
});
