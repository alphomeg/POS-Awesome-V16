import { expect, test, type Page } from "@playwright/test";

const ENABLED = process.env.POSA_SHIFT_CLOSING_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const EXPECTED_PROFILE = process.env.POSA_SHIFT_CLOSING_PROFILE || "";
const EXPECTED_CASHIER = process.env.POSA_SHIFT_CLOSING_CASHIER || "";
const EXPECTED_INVOICE = process.env.POSA_SHIFT_CLOSING_INVOICE || "";
const INVOICE_DOCTYPE = process.env.POSA_SHIFT_CLOSING_INVOICE_DOCTYPE || "POS Invoice";

test.skip(
	!ENABLED,
	"Set POSA_SHIFT_CLOSING_E2E=1 to run the live shift-closing test.",
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

async function waitForPos(page: Page) {
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Shift-closing E2E requires POSA_SMOKE_SID.");
	}
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
		"data-pos-profile",
		EXPECTED_PROFILE,
		{ timeout: 90_000 },
	);
}

function responseFor(method: string) {
	return (response: { url: () => string; status: () => number }) =>
		response.url().includes(method) && response.status() === 200;
}

test("reconciles, closes, and restores the signed cashier shift", async ({ page }) => {
	test.setTimeout(4 * 60_000);
	if (!EXPECTED_PROFILE || !EXPECTED_CASHIER || !EXPECTED_INVOICE) {
		throw new Error(
			"POSA_SHIFT_CLOSING_PROFILE, POSA_SHIFT_CLOSING_CASHIER, and POSA_SHIFT_CLOSING_INVOICE are required.",
		);
	}

	await page.setViewportSize({ width: 1366, height: 768 });
	await waitForPos(page);

	const openingContext = await callFrappe<Record<string, any>>(
		page,
		"posawesome.posawesome.api.shifts.check_opening_shift",
		{ user: EXPECTED_CASHIER },
	);
	const opening = openingContext.pos_opening_shift;
	expect(opening?.name).toBeTruthy();
	expect(opening?.pos_profile).toBe(EXPECTED_PROFILE);
	expect(opening?.user).toBe(EXPECTED_CASHIER);
	const invoice = await callFrappe<Record<string, any>>(
		page,
		"frappe.client.get",
		{ doctype: INVOICE_DOCTYPE, name: EXPECTED_INVOICE },
	);
	expect(invoice.docstatus).toBe(1);
	expect(invoice.pos_profile).toBe(EXPECTED_PROFILE);
	expect(invoice.posa_cashier).toBe(EXPECTED_CASHIER);
	expect(invoice.posa_pos_opening_shift).toBe(opening.name);

	page.on("dialog", async (dialog) => {
		if (/printed return invoice/i.test(dialog.message())) {
			await dialog.accept();
			return;
		}
		await dialog.dismiss();
	});

	const preparationResponse = page.waitForResponse(
		responseFor("make_closing_shift_from_opening"),
	);
	await page.getByRole("button", { name: "Open actions menu" }).click();
	await page.locator('[data-test="quick-action-close-shift"]').click();
	const preparationBody = await (await preparationResponse).json();
	const prepared = preparationBody?.message?.closing_shift || preparationBody?.message;
	expect(prepared?.pos_opening_shift).toBe(opening.name);
	expect(prepared?.payment_reconciliation?.length || 0).toBeGreaterThan(0);
	expect(
		prepared.pos_transactions.some(
			(row: any) =>
				row.pos_invoice === EXPECTED_INVOICE || row.sales_invoice === EXPECTED_INVOICE,
		),
	).toBe(true);

	const closingDialog = page.locator(".closing-dialog-card:visible");
	await expect(
		closingDialog.getByRole("heading", { name: "Closing POS Shift" }),
	).toBeVisible({ timeout: 30_000 });
	const rows = closingDialog.locator(".reconciliation-section tbody tr");
	for (const payment of prepared.payment_reconciliation) {
		const row = rows.filter({ hasText: payment.mode_of_payment }).first();
		await expect(row).toBeVisible();
		await row
			.locator('input[type="number"]')
			.fill(String(Number(payment.expected_amount || 0)));
	}

	const submitResponse = page.waitForResponse(responseFor("submit_closing_shift"));
	await closingDialog.getByRole("button", { name: "Submit", exact: true }).click();
	const submitBody = await (await submitResponse).json();
	const closingName = String(submitBody?.message || "");
	expect(closingName).toBeTruthy();

	const reopened = await callFrappe<Record<string, any>>(
		page,
		"posawesome.posawesome.api.shifts.create_opening_voucher",
		{
			pos_profile: EXPECTED_PROFILE,
			company: opening.company,
			balance_details: JSON.stringify(
				(opening.balance_details || []).map((row: any) => ({
					mode_of_payment: row.mode_of_payment,
					amount: Number(row.amount || 0),
				})),
			),
		},
	);
	expect(reopened.pos_opening_shift?.name).toBeTruthy();
	expect(reopened.pos_opening_shift?.pos_profile).toBe(EXPECTED_PROFILE);
	expect(reopened.pos_opening_shift?.user).toBe(EXPECTED_CASHIER);
	expect(reopened.pos_opening_shift?.status).toBe("Open");

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({ timeout: 90_000 });
	await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
		"data-pos-profile",
		EXPECTED_PROFILE,
		{ timeout: 90_000 },
	);
});
