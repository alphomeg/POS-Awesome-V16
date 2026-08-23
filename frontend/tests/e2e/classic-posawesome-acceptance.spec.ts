import { expect, test, type Locator, type Page } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
	getProvisionedTerminalCashier,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_CLASSIC_ACCEPTANCE_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const KNOWN_ITEM_CODES = ["AI167", "B4088", "AH076", "K3012", "IK140"];

test.skip(
	!ENABLED,
	"Set POSA_CLASSIC_ACCEPTANCE_E2E=1 to run Classic POS Awesome acceptance.",
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

async function waitForClassicPos(page: Page) {
	const hotCatalogueReady = page.waitForResponse(
		(response) =>
			response.url().includes("get_hot_items") &&
			response.status() === 200,
		{ timeout: 3 * 60_000 },
	);
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Classic POS acceptance requires POSA_SMOKE_SID.");
	}
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	await hotCatalogueReady;
	await ensureAuthoritativeTerminalUnlock(page);
	// On the compact Classic layout the invoice panel is below the selector and
	// can be outside the viewport; branch presence, not viewport position,
	// proves the Classic component path is active.
	await expect(page.getByTestId("classic-invoice")).toHaveCount(1, {
		timeout: 90_000,
	});
	await expect(page.getByTestId("counter-grid-pos")).toHaveCount(0);
}

async function findSaleableItem(page: Page) {
	const search = page.getByTestId("pos-item-search").locator("input");
	for (const itemCode of KNOWN_ITEM_CODES) {
		await search.fill(itemCode);
		await expect(search).toHaveValue(itemCode);
		await page.waitForTimeout(350);
		await search.press("Enter");
		const item = page.locator(`[data-item-code="${itemCode}"]`).first();
		if (
			await item
				.waitFor({ state: "visible", timeout: 30_000 })
				.then(() => true)
				.catch(() => false)
		) {
			return { itemCode, item };
		}
	}
	throw new Error(
		`No saleable Classic fixture found: ${KNOWN_ITEM_CODES.join(", ")}.`,
	);
}

async function fillClosingAmounts(closingDialog: Locator) {
	const rows = closingDialog.locator(".reconciliation-section tbody tr");
	for (let index = 0; index < (await rows.count()); index += 1) {
		const input = rows.nth(index).locator('input[type="number"]');
		await input.fill(await input.inputValue());
	}
}

test("Classic presentation submits a signed sale and closes then reopens its shift", async ({
	page,
}) => {
	test.setTimeout(7 * 60_000);
	await page.setViewportSize({ width: 1000, height: 768 });
	await waitForClassicPos(page);

	const cashier = getProvisionedTerminalCashier(page);
	if (!cashier)
		throw new Error("Classic acceptance could not provision a cashier.");
	const profile = await callFrappe<Record<string, any>>(
		page,
		"frappe.client.get",
		{ doctype: "POS Profile", name: cashier.profileName },
	);
	const invoiceDoctype = Number(
		profile.create_pos_invoice_instead_of_sales_invoice || 0,
	)
		? "POS Invoice"
		: "Sales Invoice";

	await page.evaluate(() => {
		(window as any).__classicSubmissionResponses = [];
		window.addEventListener(
			"posa:invoice-submit-response",
			(event: Event) => {
				(window as any).__classicSubmissionResponses.push(
					(event as CustomEvent).detail,
				);
			},
		);
	});

	const { itemCode, item } = await findSaleableItem(page);
	await item.click();
	await page
		.locator(".mobile-pos-dock__item--cart")
		.click({ timeout: 15_000 });
	await expect(page.getByTestId(`cart-row-${itemCode}`).first()).toBeVisible({
		timeout: 30_000,
	});

	await page.getByTestId("invoice-action-pay").click();
	const paymentRoot = page.locator('[data-testid="payment-root"]:visible');
	await expect(paymentRoot).toHaveCount(1, { timeout: 30_000 });
	await paymentRoot.getByTestId("payment-submit").click();
	const signingDialog = page.getByTestId("cashier-sale-signing-dialog");
	await expect(signingDialog).toBeVisible({ timeout: 15_000 });
	const pinInput = signingDialog
		.getByTestId("cashier-sale-pin-input")
		.locator("input");
	await pinInput.fill("000000000000");
	await pinInput.press("Enter");
	await expect(
		signingDialog.getByText("Invalid cashier PIN. Try again."),
	).toBeVisible();
	await expect(page.getByTestId("submission-recovery-banner")).toHaveCount(0);
	await expect(paymentRoot).toHaveCount(0);

	await pinInput.fill(cashier.pin);
	await pinInput.press("Enter");
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as any).__classicSubmissionResponses.length,
				),
			{ timeout: 90_000 },
		)
		.toBeGreaterThan(0);
	const submission = await page.evaluate(() =>
		(window as any).__classicSubmissionResponses.at(-1),
	);
	let submitted: Record<string, any> = {};
	await expect
		.poll(
			async () => {
				submitted = await callFrappe<Record<string, any>>(
					page,
					"frappe.client.get",
					{ doctype: invoiceDoctype, name: submission.invoice },
				);
				return Number(submitted.docstatus || 0);
			},
			{ timeout: 90_000 },
		)
		.toBe(1);
	expect(submitted).toMatchObject({ pos_profile: cashier.profileName });
	expect(submitted.posa_cashier).toBe(cashier.user);

	const preparationResponse = page.waitForResponse(
		(response) =>
			response.url().includes("make_closing_shift_from_opening") &&
			response.status() === 200,
	);
	await page.getByRole("button", { name: "Open actions menu" }).click();
	await page.locator('[data-test="quick-action-close-shift"]').click();
	const preparation = await (await preparationResponse).json();
	expect(
		preparation?.message?.closing_shift || preparation?.message,
	).toBeTruthy();
	const closingDialog = page.locator(".closing-dialog-card:visible");
	await expect(
		closingDialog.getByRole("heading", { name: "Closing POS Shift" }),
	).toBeVisible({ timeout: 30_000 });
	await fillClosingAmounts(closingDialog);
	const submitResponse = page.waitForResponse(
		(response) =>
			response.url().includes("submit_closing_shift") &&
			response.status() === 200,
	);
	await closingDialog
		.getByRole("button", { name: "Submit", exact: true })
		.click();
	expect((await (await submitResponse).json())?.message).toBeTruthy();

	await page.reload({ waitUntil: "domcontentloaded" });
	const openingDialog = page.getByTestId("opening-shift-dialog");
	await expect(openingDialog).toBeVisible({ timeout: 60_000 });
	const openingAmounts = openingDialog.locator(
		'[data-testid^="opening-shift-amount-"] input',
	);
	for (let index = 0; index < (await openingAmounts.count()); index += 1) {
		await openingAmounts.nth(index).fill("0");
	}
	const openingResponse = page.waitForResponse(
		(response) =>
			response.url().includes("create_opening_voucher") &&
			response.status() === 200,
	);
	await openingDialog.getByTestId("opening-shift-submit").click();
	expect(
		(await (await openingResponse).json())?.message?.pos_opening_shift
			?.name,
	).toBeTruthy();
	await expect(openingDialog).toBeHidden({ timeout: 45_000 });
});

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page);
});
