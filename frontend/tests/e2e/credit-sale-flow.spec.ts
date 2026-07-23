import { expect, test, type Page } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
	getProvisionedTerminalCashier,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_CREDIT_SALE_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const KNOWN_ITEM_CODES = ["02017", "02016", "02249", "A3106", "22203"];

test.skip(!ENABLED, "Set POSA_CREDIT_SALE_E2E=1 to run the credit-sale E2E.");

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

async function addKnownItem(page: Page) {
	for (const itemCode of KNOWN_ITEM_CODES) {
		const entry = page.getByTestId("counter-grid-item-entry");
		await entry.fill(itemCode);
		await entry.press("Enter");
		const search = page.getByTestId("pos-item-search").locator("input");
		await expect(search).toBeVisible({ timeout: 30_000 });
		const result = page.getByTestId(`pos-item-row-${itemCode}`);
		if (await result.isVisible({ timeout: 8_000 }).catch(() => false)) {
			await search.press("Enter");
			await expect(page.getByTestId(`cart-row-${itemCode}`).first()).toBeVisible({
				timeout: 30_000,
			});
			return;
		}
		await page.getByRole("button", { name: "Close item search" }).click();
	}
	throw new Error("No saleable fixture item was available.");
}

function responseFor(method: string) {
	return (response: { url: () => string; status: () => number }) =>
		response.url().includes(method) && response.status() === 200;
}

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page);
});

test("submits, closes, and fully collects an authorized named-customer credit sale", async ({
	page,
}) => {
	test.setTimeout(7 * 60_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error("Credit-sale E2E requires POSA_SMOKE_SID.");
	}
	await ensureAuthoritativeTerminalUnlock(page);
	const provisioned = getProvisionedTerminalCashier(page);
	if (!provisioned) {
		throw new Error("Run with POSA_E2E_PROVISION_CASHIER=1.");
	}
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});

	const profileName =
		(await page
			.locator('[data-test="pos-navbar"]')
			.getAttribute("data-pos-profile")) || "";
	const profile = await callFrappe<Record<string, any>>(page, "frappe.client.get", {
		doctype: "POS Profile",
		name: profileName,
	});
	expect(Number(profile.posa_allow_credit_sale || 0)).toBe(1);
	expect(Number(profile.posa_allow_make_new_payments || 0)).toBe(1);
	const customerName = `POS Credit E2E ${Date.now()}`;
	let customerId = "";

	let submittedDoctype = "";
	let submittedInvoice = "";
	let opening: Record<string, any> | null = null;
	let shiftClosed = false;
	let shiftReopened = false;
	try {
		const customerInput = page.locator(".customer-autocomplete input").first();
		await customerInput.click();
		await page.getByTestId("counter-grid-customer-add").click();
		const customerDialog = page
			.getByRole("dialog")
			.filter({ hasText: "Create Customer" });
		await expect(customerDialog).toBeVisible({ timeout: 30_000 });
		await customerDialog.getByLabel(/Customer Name/).fill(customerName);
		for (const requiredSelect of [/Customer Group/, /Territory/]) {
			await customerDialog
				.getByRole("combobox", { name: requiredSelect })
				.click();
			await page.getByRole("option").first().click();
		}
		await customerDialog.getByRole("button", { name: "Submit" }).click();
		await expect(customerDialog).toBeHidden({ timeout: 30_000 });
		customerId = customerName;
		const createdCustomers = await callFrappe<Record<string, any>[]>(
			page,
			"frappe.client.get_list",
			{
				doctype: "Customer",
				filters: { customer_name: customerName },
				fields: ["name"],
				limit_page_length: 1,
			},
		);
		customerId = createdCustomers[0]?.name || "";
		expect(customerId).toBeTruthy();
		await customerInput.fill(customerName);
		await customerInput.press("Enter");
		await expect(page.getByTestId("counter-grid-customer-edit")).toBeEnabled();
		await customerInput.press("Escape");
		await addKnownItem(page);

		await page.evaluate(() => {
			(window as any).__creditSaleResponses = [];
			window.addEventListener("posa:invoice-submit-response", (event: Event) => {
				(window as any).__creditSaleResponses.push((event as CustomEvent).detail);
			});
		});

		await page.getByTestId("invoice-action-pay").click();
		await expect(page.getByTestId("payment-submit")).toBeEnabled({ timeout: 30_000 });
		await page.getByTestId("payment-submit").click();

		const signer = page.getByTestId("cashier-sale-signing-dialog");
		await expect(signer).toBeVisible({ timeout: 30_000 });
		await expect(signer).toContainText("RetailMind-POS");
		await expect(signer).toContainText(customerName);
		await signer.getByTestId("cashier-sale-credit").click();
		await expect(signer.getByTestId("cashier-sale-received-amount")).toHaveValue("0");
		const pin = signer.getByTestId("cashier-sale-pin-input").locator("input");
		await pin.fill(provisioned.pin);
		await pin.press("Enter");

		await expect
			.poll(
				() =>
					page.evaluate(() => (window as any).__creditSaleResponses.length),
				{ timeout: 90_000 },
			)
			.toBeGreaterThan(0);
		const response = await page.evaluate(() =>
			(window as any).__creditSaleResponses.at(-1),
		);
		submittedInvoice = response.invoice;
		submittedDoctype =
			response.doctype ||
			(Number(profile.create_pos_invoice_instead_of_sales_invoice || 0)
				? "POS Invoice"
				: "Sales Invoice");
		const invoice = await callFrappe<Record<string, any>>(page, "frappe.client.get", {
			doctype: submittedDoctype,
			name: submittedInvoice,
		});
		expect(Number(invoice.docstatus)).toBe(1);
		expect(Number(invoice.posa_is_credit_sale)).toBe(1);
		expect(Number(invoice.outstanding_amount)).toBeGreaterThan(0);
		expect(
			(invoice.payments || []).reduce(
				(sum: number, payment: any) => sum + Number(payment.amount || 0),
				0,
			),
		).toBe(0);
		expect(invoice.due_date).toBe(invoice.posting_date);

		opening = await callFrappe<Record<string, any>>(page, "frappe.client.get", {
			doctype: "POS Opening Shift",
			name: invoice.posa_pos_opening_shift,
		});
		expect(opening?.name).toBeTruthy();
		expect(opening?.pos_profile).toBe(profileName);

		const preparationResponse = page.waitForResponse(
			responseFor("make_closing_shift_from_opening"),
		);
		await page.getByRole("button", { name: "Open actions menu" }).click();
		await page.locator('[data-test="quick-action-close-shift"]').click();
		const preparationBody = await (await preparationResponse).json();
		const prepared =
			preparationBody?.message?.closing_shift || preparationBody?.message;
		expect(prepared?.pos_opening_shift).toBe(opening.name);
		expect(
			(prepared?.pos_transactions || []).some(
				(row: any) =>
					row.pos_invoice === submittedInvoice ||
					row.sales_invoice === submittedInvoice,
			),
		).toBe(true);

		const closingDialog = page.locator(".closing-dialog-card:visible");
		await expect(
			closingDialog.getByRole("heading", { name: "Closing POS Shift" }),
		).toBeVisible({ timeout: 30_000 });
		const reconciliationRows = closingDialog.locator(
			".reconciliation-section tbody tr",
		);
		for (const payment of prepared.payment_reconciliation || []) {
			const row = reconciliationRows
				.filter({ hasText: payment.mode_of_payment })
				.first();
			await expect(row).toBeVisible();
			await row
				.locator('input[type="number"]')
				.fill(String(Number(payment.expected_amount || 0)));
		}

		const closeResponse = page.waitForResponse(
			responseFor("submit_closing_shift"),
		);
		await closingDialog
			.getByRole("button", { name: "Submit", exact: true })
			.click();
		const closeBody = await (await closeResponse).json();
		expect(String(closeBody?.message || "")).toBeTruthy();
		shiftClosed = true;

		const consolidatedSource = await callFrappe<Record<string, any>>(
			page,
			"frappe.client.get",
			{ doctype: "POS Invoice", name: submittedInvoice },
		);
		const consolidatedInvoice = String(
			consolidatedSource.consolidated_invoice || "",
		);
		expect(consolidatedInvoice).toBeTruthy();
		const consolidatedBefore = await callFrappe<Record<string, any>>(
			page,
			"frappe.client.get",
			{ doctype: "Sales Invoice", name: consolidatedInvoice },
		);
		const outstandingBefore = Number(
			consolidatedBefore.outstanding_amount || 0,
		);
		expect(Number(consolidatedBefore.posa_is_credit_sale || 0)).toBe(1);
		expect(outstandingBefore).toBeGreaterThan(0);

		const reopened = await callFrappe<Record<string, any>>(
			page,
			"posawesome.posawesome.api.shifts.create_opening_voucher",
			{
				pos_profile: profileName,
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
		shiftReopened = true;

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
			timeout: 90_000,
		});
		await expect(page.locator(".loading-overlay")).toHaveCount(0, {
			timeout: 90_000,
		});

		await page.getByTestId("invoice-action-management").click();
		const management = page.getByTestId("invoice-management-dialog");
		await expect(management).toBeVisible({ timeout: 30_000 });
		await management.getByRole("tab", { name: /Unpaid/ }).click();
		await management.getByRole("button", { name: "Cards" }).click();
		const unpaidCard = management
			.locator(".invoice-record-card:visible")
			.filter({ hasText: consolidatedInvoice })
			.first();
		await expect(unpaidCard).toBeVisible({ timeout: 60_000 });
		await unpaidCard
			.getByRole("button", { name: "Add Payment", exact: true })
			.click();

		await expect(page).toHaveURL(/\/payments(?:[/?#]|$)/, {
			timeout: 30_000,
		});
		await expect(page.locator(".loading-overlay")).toHaveCount(0, {
			timeout: 90_000,
		});
		await expect(page.getByText(consolidatedInvoice, { exact: true }).first()).toBeVisible({
			timeout: 60_000,
		});

		const modeOfPayment =
			(profile.payments || []).find((row: any) => row.default)
				?.mode_of_payment ||
			(profile.payments || [])[0]?.mode_of_payment;
		expect(modeOfPayment).toBeTruthy();
		const paymentSidebar = page.getByText("Make New Payment", {
			exact: true,
		}).locator("..").locator("..");
		const modeSelect = paymentSidebar.getByRole("combobox", {
			name: "Mode of Payment",
		});
		if ((await modeSelect.inputValue()) !== String(modeOfPayment)) {
			await modeSelect.click();
			await page
				.getByRole("option", { name: String(modeOfPayment), exact: true })
				.click();
		}
		await paymentSidebar
			.locator(".payment-amount-input input")
			.fill(String(outstandingBefore));

		const paymentResponse = page.waitForResponse(
			responseFor("process_pos_payment"),
		);
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		const paymentBody = await (await paymentResponse).json();
		expect(
			paymentBody?.message?.new_payments_entry?.[0]?.name,
		).toBeTruthy();

		await expect
			.poll(
				async () => {
					const settled = await callFrappe<Record<string, any>>(
						page,
						"frappe.client.get",
						{ doctype: "Sales Invoice", name: consolidatedInvoice },
					);
					return Number(settled.outstanding_amount || 0);
				},
				{ timeout: 60_000 },
			)
			.toBe(0);
	} finally {
		if (shiftClosed && !shiftReopened && opening) {
			await callFrappe(
				page,
				"posawesome.posawesome.api.shifts.create_opening_voucher",
				{
					pos_profile: profileName,
					company: opening.company,
					balance_details: JSON.stringify(
						(opening.balance_details || []).map((row: any) => ({
							mode_of_payment: row.mode_of_payment,
							amount: Number(row.amount || 0),
						})),
					),
				},
			).catch(() => null);
		}
		if (!shiftClosed && submittedInvoice && submittedDoctype) {
			await callFrappe(page, "frappe.client.cancel", {
				doctype: submittedDoctype,
				name: submittedInvoice,
			}).catch(() => null);
			await callFrappe(page, "frappe.client.delete", {
				doctype: submittedDoctype,
				name: submittedInvoice,
			}).catch(() => null);
		}
		if (!shiftClosed && customerId) {
			await callFrappe(page, "frappe.client.delete", {
				doctype: "Customer",
				name: customerId,
			}).catch(() => null);
		}
	}
});
