import { expect, test, type Page } from "@playwright/test";

const ENABLED = process.env.POSA_CASHIER_SIGNING_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const EXPECTED_PROFILE = process.env.POSA_SIGNING_E2E_PROFILE || "";
const EXPECTED_CASHIER = process.env.POSA_SIGNING_E2E_CASHIER || "";
const CASHIER_PIN = process.env.POSA_E2E_CASHIER_PIN || "";
const SUBMISSION_TRIGGER = process.env.POSA_SIGNING_E2E_TRIGGER || "pay";
const KNOWN_ITEM_CODES = ["02017", "02016", "02249", "A3106", "22203"];

test.skip(
	!ENABLED,
	"Set POSA_CASHIER_SIGNING_E2E=1 to run the live cashier-signing sale test.",
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

function isBenignConsoleError(message: string) {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("remove_last_divider") ||
		(normalized.includes("offsetwidth") &&
			normalized.includes("shortcut.js"))
	);
}

async function waitForPos(page: Page) {
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Cashier-signing E2E requires POSA_SMOKE_SID.");
	}
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	const navbar = page.locator('[data-test="pos-navbar"]');
	await expect(navbar).toHaveAttribute("data-pos-profile", EXPECTED_PROFILE, {
		timeout: 90_000,
	});
}

async function addKnownItem(page: Page) {
	for (const itemCode of KNOWN_ITEM_CODES) {
		const entry = page.getByTestId("counter-grid-item-entry");
		await entry.fill(itemCode);
		await entry.press("Enter");
		const search = page.getByTestId("pos-item-search").locator("input");
		await expect(search).toBeVisible({ timeout: 30_000 });
		const result = page.getByTestId(`pos-item-row-${itemCode}`);
		const resultReady = await result
			.waitFor({ state: "visible", timeout: 30_000 })
			.then(() => true)
			.catch(() => false);
		if (resultReady) {
			await expect(result).toHaveAttribute("aria-selected", "true");
			await search.press("Enter");
			await expect(
				page.getByTestId(`cart-row-${itemCode}`).first(),
			).toBeVisible({ timeout: 30_000 });
			return itemCode;
		}
		await page.getByRole("button", { name: "Close item search" }).click();
	}
	throw new Error(
		`No saleable fixture item found: ${KNOWN_ITEM_CODES.join(", ")}`,
	);
}

test("submits a keyboard-signed sale with an exact profile payment method", async ({
	page,
}) => {
	test.setTimeout(4 * 60_000);
	if (!EXPECTED_PROFILE || !EXPECTED_CASHIER || !CASHIER_PIN) {
		throw new Error(
			"POSA_SIGNING_E2E_PROFILE, POSA_SIGNING_E2E_CASHIER, and POSA_E2E_CASHIER_PIN are required.",
		);
	}

	const globalErrors: string[] = [];
	page.on("pageerror", (error) => {
		const message = String(error?.message || error);
		if (!isBenignConsoleError(message))
			globalErrors.push(`pageerror: ${message}`);
	});
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		const text = message.text();
		if (!isBenignConsoleError(text))
			globalErrors.push(`console.error: ${text}`);
	});

	await page.setViewportSize({ width: 1366, height: 768 });
	await waitForPos(page);
	const profile = await callFrappe<Record<string, any>>(
		page,
		"frappe.client.get",
		{ doctype: "POS Profile", name: EXPECTED_PROFILE },
	);
	const invoiceDoctype = Number(
		profile.create_pos_invoice_instead_of_sales_invoice || 0,
	)
		? "POS Invoice"
		: "Sales Invoice";
	const expectedPaymentMethods = (profile.payments || []).map(
		(payment: any) => payment.mode_of_payment,
	);
	expect(expectedPaymentMethods.length).toBeGreaterThan(1);

	await page.evaluate(() => {
		(window as any).__cashierSigningResponses = [];
		window.addEventListener(
			"posa:invoice-submit-response",
			(event: Event) => {
				(window as any).__cashierSigningResponses.push(
					(event as CustomEvent).detail,
				);
			},
		);
	});

	const itemCode = await addKnownItem(page);
	const signingDialog = page.getByTestId("cashier-sale-signing-dialog");
	if (SUBMISSION_TRIGGER === "shortcuts") {
		await page.keyboard.press("Alt+P");
		await expect(signingDialog).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("payment-root")).toBeHidden();
		await expect(page.locator("[role='dialog']:visible")).toHaveCount(1);
		await expect(
			signingDialog.getByTestId("cashier-sale-pin-input").locator("input"),
		).toBeFocused();
		await signingDialog.getByTestId("cashier-sale-cancel").click();
		await expect(signingDialog).toBeHidden({ timeout: 15_000 });
		await expect(page.getByTestId(`cart-row-${itemCode}`).first()).toBeVisible();

		await page.keyboard.press("Alt+X");
		await expect(signingDialog).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("payment-root")).toBeHidden();
		await expect(page.locator("[role='dialog']:visible")).toHaveCount(1);
		await expect(
			signingDialog.getByTestId("cashier-sale-pin-input").locator("input"),
		).toBeFocused();
	} else {
		await page.getByTestId("invoice-action-pay").click();
		await expect(page.getByTestId("payment-root")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByTestId("payment-submit")).toBeEnabled({
			timeout: 15_000,
		});
		await page.getByTestId("payment-submit").click();
	}

	await expect(signingDialog).toBeVisible({ timeout: 15_000 });
	const paymentMethods = signingDialog.getByTestId(
		"cashier-sale-payment-method",
	);
	await expect(paymentMethods).toHaveCount(expectedPaymentMethods.length);
	expect(await paymentMethods.locator("strong").allTextContents()).toEqual(
		expectedPaymentMethods,
	);
	await expect(paymentMethods.first()).toHaveAttribute(
		"aria-checked",
		"true",
	);

	const pinInput = signingDialog
		.getByTestId("cashier-sale-pin-input")
		.locator("input");
	await expect(pinInput).toBeFocused();
	await pinInput.fill(CASHIER_PIN);
	await pinInput.press("ArrowDown");
	await expect(paymentMethods.nth(1)).toHaveAttribute("aria-checked", "true");
	await pinInput.press("ArrowUp");
	await expect(paymentMethods.first()).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await pinInput.press("Enter");

	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as any).__cashierSigningResponses.length,
				),
			{ timeout: 60_000 },
		)
		.toBeGreaterThan(0);
	const response = await page.evaluate(() =>
		(window as any).__cashierSigningResponses.at(-1),
	);
	expect(response?.requestId).toBeTruthy();
	expect(response?.invoice).toBeTruthy();

	let submittedInvoice: any = null;
	await expect
		.poll(
			async () => {
				submittedInvoice = await callFrappe(page, "frappe.client.get", {
					doctype: invoiceDoctype,
					name: response.invoice,
				});
				return Number(submittedInvoice?.docstatus || 0);
			},
			{ timeout: 90_000 },
		)
		.toBe(1);

	expect(submittedInvoice.pos_profile).toBe(EXPECTED_PROFILE);
	expect(submittedInvoice.posa_cashier).toBe(EXPECTED_CASHIER);
	expect(submittedInvoice.posa_client_request_id).toBe(response.requestId);
	const positivePayments = (submittedInvoice.payments || []).filter(
		(payment: any) => Number(payment.amount || 0) > 0,
	);
	expect(positivePayments).toHaveLength(1);
	expect(positivePayments[0].mode_of_payment).toBe(expectedPaymentMethods[0]);

	const history = await callFrappe<any[]>(
		page,
		"posawesome.posawesome.api.submitted_invoice_edits.list_submitted_invoices",
		{
			doctype: invoiceDoctype,
			filters: JSON.stringify({ name: response.invoice }),
			fields: JSON.stringify(["name", "posa_cashier"]),
			pos_profile: EXPECTED_PROFILE,
			limit_page_length: 1,
		},
	);
	expect(history).toHaveLength(1);
	expect(history[0].posa_cashier).toBe(EXPECTED_CASHIER);
	expect(history[0].posa_cashier_name).toBeTruthy();
	await expect(signingDialog).toBeHidden({ timeout: 30_000 });
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 30_000,
	});
	expect(globalErrors, globalErrors.join("\n")).toHaveLength(0);
});
