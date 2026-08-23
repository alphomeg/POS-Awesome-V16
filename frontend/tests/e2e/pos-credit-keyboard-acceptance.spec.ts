import { randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
	expect,
	test,
	type Locator,
	type Page,
	type TestInfo,
} from "@playwright/test";

const ENABLED = process.env.POSA_CREDIT_KEYBOARD_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const POS_PROFILE =
	process.env.POSA_CREDIT_KEYBOARD_PROFILE || "MedPlus POS 1 - Supervisor";
const CUSTOMER =
	process.env.POSA_CREDIT_KEYBOARD_CUSTOMER ||
	"VITAL PHARMACY , BRANCH 2 (1413)";
const ITEM_CODE = process.env.POSA_CREDIT_KEYBOARD_ITEM || "AI167";
const SALE_COUNT = positiveInteger(process.env.POSA_CREDIT_KEYBOARD_SALES, 100);
const FIRST_COLLECTION_COUNT = positiveInteger(
	process.env.POSA_CREDIT_KEYBOARD_FIRST_COLLECTION,
	50,
);
const RESUME_REPORT_PATH = process.env.POSA_CREDIT_KEYBOARD_RESUME_REPORT || "";
const RESUME_CASHIER = process.env.POSA_CREDIT_KEYBOARD_RESUME_CASHIER || "";
const REQUEST_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 15 * 60_000;
const STOCK_METHOD =
	"posawesome.posawesome.api.item_processing.stock.get_available_qty";

type TemporaryCashier = { user: string; pin: string };
type StockSnapshot = {
	capturedAt: string;
	availableQty: number;
	binActualQty: number;
	reservedQty: number;
};
type CreditSaleEvidence = {
	sale: number;
	posInvoice: string;
	requestId: string;
	dueDate: string;
	grandTotal: number;
	outstandingAmount: number;
	ledgerState: string;
	stockBefore: StockSnapshot;
	stockAfter: StockSnapshot;
	availableDelta: number;
	deltaMatches: boolean;
	searchLatencyMs: number;
	signingLatencyMs: number;
	submissionLatencyMs: number;
	consolidatedInvoice?: string;
};

test.skip(
	!ENABLED,
	"Set POSA_CREDIT_KEYBOARD_E2E=1 to run the destructive keyboard credit acceptance.",
);
test.use({ video: "off", trace: "off" });

function positiveInteger(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asNumber(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(date: Date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function dateKeyboardDigits(isoDate: string) {
	const [year, month, day] = isoDate.split("-");
	// Chromium's native date editor follows this environment's DMY segment
	// order even though input.value remains ISO YYYY-MM-DD.
	return `${day}${month}${year}`;
}

function percentile(values: number[], fraction: number) {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[
		Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
	];
}

function latencySummary(values: number[]) {
	return {
		count: values.length,
		minMs: values.length ? Math.min(...values) : 0,
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		maxMs: values.length ? Math.max(...values) : 0,
	};
}

function responseFor(method: string) {
	return (response: { url: () => string }) => response.url().includes(method);
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
							() =>
								reject(
									new Error(
										`${callMethod} exceeded ${timeoutMs}ms`,
									),
								),
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

async function tabTo(page: Page, target: Locator, maxTabs = 800) {
	await expect(target).toBeAttached({ timeout: 30_000 });
	await expect(target).toBeEnabled({ timeout: 30_000 });
	for (let step = 0; step <= maxTabs; step += 1) {
		const ownsFocus = await target
			.evaluate(
				(element) =>
					element === document.activeElement ||
					element.contains(document.activeElement),
			)
			.catch(() => false);
		if (ownsFocus) return step;
		await page.keyboard.press("Tab");
	}
	throw new Error(
		`Keyboard focus did not reach target after ${maxTabs} Tab presses.`,
	);
}

async function keyboardActivate(
	page: Page,
	target: Locator,
	key: "Enter" | "Space" = "Enter",
) {
	await tabTo(page, target);
	await page.keyboard.press(key);
}

async function keyboardReplace(page: Page, target: Locator, value: string) {
	await tabTo(page, target);
	await page.keyboard.press("Meta+A");
	await page.keyboard.type(value);
}

async function startPointerAudit(page: Page) {
	await page.evaluate(() => {
		(window as any).__creditKeyboardPointerActions = [];
		for (const eventName of ["pointerdown", "mousedown", "click"]) {
			document.addEventListener(
				eventName,
				(event) => {
					const mouseEvent = event as MouseEvent;
					if (mouseEvent.detail <= 0) return;
					const target = event.target as HTMLElement | null;
					(window as any).__creditKeyboardPointerActions.push({
						event: eventName,
						tag: target?.tagName || "",
						testId:
							target
								?.closest?.("[data-testid]")
								?.getAttribute("data-testid") || "",
						text: String(target?.textContent || "")
							.trim()
							.slice(0, 120),
					});
				},
				true,
			);
		}
	});
}

async function provisionTemporarySupervisor(page: Page, profileName: string) {
	const token = `${Date.now()}-${randomInt(100000, 1000000)}`;
	const user = `posa-credit-keyboard-${token}@retailmind.invalid`;
	const pin = String(randomInt(100000, 1000000));
	await callFrappe(page, "frappe.client.insert", {
		doc: {
			doctype: "User",
			email: user,
			username: `posa_credit_keyboard_${token}`,
			first_name: "POS Credit Keyboard Supervisor",
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
		{
			pos_profile: profileName,
		},
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

async function cleanupTemporarySupervisor(
	page: Page,
	profileName: string,
	cashier: TemporaryCashier,
) {
	await callFrappe(
		page,
		"posawesome.posawesome.api.employees.lock_terminal",
		{
			pos_profile: profileName,
		},
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
	await callFrappe(page, "frappe.client.set_value", {
		doctype: "User",
		name: cashier.user,
		fieldname: { enabled: 0, posa_pos_pin: "" },
	}).catch(() => null);
}

async function cleanupOrphanedTemporarySupervisors(
	page: Page,
	profileName: string,
) {
	const users = await callFrappe<Array<{ name: string }>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "User",
			filters: [
				["name", "like", "posa-credit-keyboard-%@retailmind.invalid"],
				["enabled", "=", 1],
			],
			fields: ["name"],
			limit_page_length: 500,
		},
	);
	for (const user of users) {
		await cleanupTemporarySupervisor(page, profileName, {
			user: user.name,
			pin: "",
		});
	}
	return users.length;
}

async function waitForPosReady(page: Page) {
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
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

async function openShiftByKeyboard(page: Page) {
	const dialog = page.getByTestId("opening-shift-dialog");
	await expect(dialog).toBeVisible({ timeout: 90_000 });
	const inputs = dialog.locator(
		'[data-testid^="opening-shift-amount-"] input',
	);
	for (let index = 0; index < (await inputs.count()); index += 1) {
		await keyboardReplace(page, inputs.nth(index), "0");
	}
	const responsePromise = page.waitForResponse(
		responseFor("create_opening_voucher"),
		{
			timeout: CLOSE_TIMEOUT_MS,
		},
	);
	await keyboardActivate(page, dialog.getByTestId("opening-shift-submit"));
	const response = await responsePromise;
	const body = await response.json().catch(() => ({}));
	const opening = body?.message?.pos_opening_shift || body?.message;
	expect(opening?.name, JSON.stringify(body).slice(0, 1000)).toBeTruthy();
	await expect(dialog).toBeHidden({ timeout: 90_000 });
	await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused({
		timeout: 90_000,
	});
	return String(opening.name);
}

async function ensureOpenShiftByKeyboard(page: Page, profileName: string) {
	if (
		await page
			.getByTestId("opening-shift-dialog")
			.isVisible()
			.catch(() => false)
	) {
		return openShiftByKeyboard(page);
	}
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 90_000,
	});
	const rows = await callFrappe<Array<Record<string, any>>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "POS Opening Shift",
			filters: { pos_profile: profileName, status: "Open", docstatus: 1 },
			fields: ["name"],
			order_by: "creation desc",
			limit_page_length: 2,
		},
	);
	expect(rows).toHaveLength(1);
	return String(rows[0].name);
}

async function closeShiftByKeyboard(page: Page) {
	const preparationResponse = page.waitForResponse(
		responseFor("make_closing_shift_from_opening"),
		{ timeout: CLOSE_TIMEOUT_MS },
	);
	await page.keyboard.press("F7");
	const preparationBody = await (await preparationResponse).json();
	const prepared =
		preparationBody?.message?.closing_shift || preparationBody?.message;
	expect(prepared?.pos_opening_shift).toBeTruthy();
	const dialog = page.locator(".closing-dialog-card:visible");
	await expect(dialog).toBeVisible({ timeout: CLOSE_TIMEOUT_MS });
	const rows = dialog.locator(".reconciliation-section tbody tr");
	for (const payment of prepared.payment_reconciliation || []) {
		const input = rows
			.filter({ hasText: String(payment.mode_of_payment) })
			.first()
			.locator('input[type="number"]');
		await keyboardReplace(
			page,
			input,
			String(asNumber(payment.expected_amount)),
		);
	}
	const submitResponse = page.waitForResponse(
		responseFor("submit_closing_shift"),
		{
			timeout: CLOSE_TIMEOUT_MS,
		},
	);
	await keyboardActivate(
		page,
		dialog.getByRole("button", { name: "Submit", exact: true }),
	);
	const submitBody = await (await submitResponse).json().catch(() => ({}));
	expect(
		String(submitBody?.message || ""),
		JSON.stringify(submitBody).slice(0, 1000),
	).toBeTruthy();
	await expect(dialog).toBeHidden({ timeout: CLOSE_TIMEOUT_MS });
	await expect(page.getByTestId("opening-shift-dialog")).toBeVisible({
		timeout: CLOSE_TIMEOUT_MS,
	});
	return String(submitBody.message);
}

async function selectCustomerByKeyboard(page: Page, customer: string) {
	await page.keyboard.press("Alt+5");
	const input = page.locator(".customer-autocomplete input").first();
	await expect(input).toBeFocused({ timeout: 15_000 });
	await page.keyboard.press("Meta+A");
	await page.keyboard.type(customer);
	const option = page.getByRole("option", { name: customer, exact: true });
	await expect(option).toBeVisible({ timeout: 30_000 });
	// Exact-match Enter is captured by Customer.vue before Vuetify can commit a
	// stale active row from the prior asynchronous result set.
	await page.keyboard.press("Enter");
	// Vuetify clears the internal search input after committing the model; the
	// selected label is the authoritative rendered customer value.
	await expect(page.locator(".customer-autocomplete").first()).toContainText(
		customer,
		{ timeout: 30_000 },
	);
}

async function addItemByKeyboard(page: Page, itemCode: string) {
	await page.keyboard.press("F2");
	const entry = page.getByTestId("counter-grid-item-entry");
	await expect(entry).toBeFocused({ timeout: 15_000 });
	await page.keyboard.type(itemCode);
	const startedAt = Date.now();
	await page.keyboard.press("Enter");
	const selector = page.locator(".items-selector-shell--counter-dialog");
	await expect(selector).toHaveAttribute(
		"data-search-ready-query",
		itemCode,
		{
			timeout: 30_000,
		},
	);
	await expect(selector).toHaveAttribute("data-search-pending", "false", {
		timeout: 30_000,
	});
	const result = page.getByTestId(`pos-item-row-${itemCode}`).first();
	await expect(result).toBeVisible({ timeout: 30_000 });
	await expect(result).toHaveAttribute("aria-selected", "true");
	const searchInput = page.getByTestId("pos-item-search").locator("input");
	await expect(searchInput).toBeFocused({ timeout: 10_000 });
	await searchInput.press("Enter");
	await expect(page.getByTestId(`cart-row-${itemCode}`).first()).toBeVisible({
		timeout: 30_000,
	});
	return Date.now() - startedAt;
}

async function typeDateByKeyboard(page: Page, input: Locator, isoDate: string) {
	await expect(input).toBeFocused({ timeout: 10_000 });
	await page.keyboard.press("Meta+A");
	await page.keyboard.type(dateKeyboardDigits(isoDate));
	await expect(input).toHaveValue(isoDate, { timeout: 10_000 });
}

async function submitCreditSaleByKeyboard(
	page: Page,
	pin: string,
	dueDate: string,
) {
	const eventIndex = await page.evaluate(
		() => (window as any).__creditKeyboardResponses.length,
	);
	const startedAt = Date.now();
	await page.keyboard.press("Alt+X");
	const dialog = page.getByTestId("cashier-sale-signing-dialog");
	await expect(dialog).toBeVisible({ timeout: 30_000 });
	const signingLatencyMs = Date.now() - startedAt;
	const pinInput = dialog
		.getByTestId("cashier-sale-pin-input")
		.locator("input");
	await expect(pinInput).toBeFocused({ timeout: 10_000 });
	const creditButton = dialog.getByTestId("cashier-sale-credit");
	await expect(creditButton).toBeEnabled({ timeout: 30_000 });
	await page.keyboard.press("Shift+Tab");
	await expect(creditButton).toBeFocused({ timeout: 10_000 });
	await page.keyboard.press("Enter");
	await expect(creditButton).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Tab");
	const receivedInput = dialog.getByTestId("cashier-sale-received-amount");
	await expect(receivedInput).toBeFocused({ timeout: 10_000 });
	await expect(receivedInput).toHaveValue("0");
	await page.keyboard.press("Tab");
	const dueInput = dialog.getByTestId("cashier-sale-due-date");
	await typeDateByKeyboard(page, dueInput, dueDate);
	await tabTo(page, pinInput, 10);
	await page.keyboard.type(pin);
	await page.keyboard.press("Enter");
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as any).__creditKeyboardResponses.length,
				),
			{ timeout: 90_000 },
		)
		.toBeGreaterThan(eventIndex);
	const response = await page.evaluate(() =>
		(window as any).__creditKeyboardResponses.at(-1),
	);
	expect(response?.invoice).toBeTruthy();
	expect(response?.requestId).toBeTruthy();
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

async function waitForFinalLedger(
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
						filters: { client_request_id: requestId },
						fields: ["state", "invoice_name", "error_message"],
						limit_page_length: 2,
					},
				);
				latest = rows[0] || null;
				if (latest?.state === "FAILED") {
					throw new Error(
						`Credit sale ${invoiceName} failed: ${latest.error_message || "unknown error"}`,
					);
				}
				return latest?.state || "MISSING";
			},
			{ timeout: 120_000, intervals: [250, 500, 1000, 2000] },
		)
		.toBe("POST_SUBMIT_DONE");
	return String(latest?.state || "");
}

async function captureStock(
	page: Page,
	itemCode: string,
	warehouse: string,
): Promise<StockSnapshot> {
	const availability = await callFrappe<
		Array<{ item_code: string; available_qty: number }>
	>(page, STOCK_METHOD, {
		items: [{ item_code: itemCode, warehouse }],
	});
	const bins = await callFrappe<Array<{ actual_qty: number }>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "Bin",
			filters: { item_code: itemCode, warehouse },
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
		availableQty,
		binActualQty,
		reservedQty: binActualQty - availableQty,
	};
}

async function openFirstInvoicePaymentFromCounter(
	page: Page,
	invoiceName: string,
) {
	await keyboardActivate(page, page.getByTestId("invoice-action-management"));
	const management = page.getByTestId("invoice-management-dialog");
	await expect(management).toBeVisible({ timeout: 60_000 });
	const historyTab = management.getByRole("tab", { name: /History/ });
	await tabTo(page, historyTab);
	await page.keyboard.press("ArrowRight");
	await expect(
		management.getByRole("tab", { name: /Unpaid/ }),
	).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
	const search = management.getByRole("textbox", {
		name: "Search unpaid invoices or customers",
	});
	await keyboardReplace(page, search, invoiceName);
	await expect(search).toHaveValue(invoiceName);
	const row = management
		.locator(".invoice-record-card--unpaid")
		.filter({ hasText: invoiceName });
	await expect(row).toBeVisible({ timeout: 30_000 });
	await keyboardActivate(
		page,
		row.getByRole("button", { name: "Add Payment", exact: true }),
	);
	await expect(page).toHaveURL(/\/payments(?:[/?#]|$)/, { timeout: 30_000 });
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
	await expect(
		page.getByText("1 invoice(s)", { exact: true }).first(),
	).toBeVisible({
		timeout: 60_000,
	});
}

async function showAllPaymentInvoicesByKeyboard(
	page: Page,
	minimumRows: number,
) {
	const invoiceTable = page.locator(".main .v-data-table").first();
	const footerSelect = invoiceTable.locator(
		".v-data-table-footer__items-per-page input",
	);
	if ((await footerSelect.count()) > 0) {
		await tabTo(page, footerSelect);
		await page.keyboard.press("Enter");
		const allOption = page.getByRole("option", {
			name: "All",
			exact: true,
		});
		await expect(allOption).toBeVisible({ timeout: 10_000 });
		for (let step = 0; step < 4; step += 1) {
			await page.keyboard.press("ArrowDown");
		}
		await page.keyboard.press("Enter");
	}
	await expect
		.poll(() => invoiceTable.locator("tbody tr").count(), {
			timeout: 30_000,
		})
		.toBeGreaterThanOrEqual(minimumRows);
	return invoiceTable;
}

async function selectInvoiceGroupByKeyboard(
	page: Page,
	invoiceTable: Locator,
	invoiceNames: string[],
	preselected = new Set<string>(),
) {
	const rows = invoiceTable.locator("tbody tr");
	const desired = new Set(invoiceNames);
	const ordered: Array<{ name: string; checkbox: Locator }> = [];
	for (let index = 0; index < (await rows.count()); index += 1) {
		const row = rows.nth(index);
		const text = await row.innerText();
		const name = invoiceNames.find((candidate) => text.includes(candidate));
		if (name && desired.has(name)) {
			ordered.push({
				name,
				checkbox: row.locator('input[type="checkbox"]').first(),
			});
		}
	}
	expect(ordered.map((entry) => entry.name).sort()).toEqual(
		[...invoiceNames].sort(),
	);
	for (const entry of ordered) {
		if (preselected.has(entry.name)) {
			await expect(entry.checkbox).toBeChecked();
			continue;
		}
		await tabTo(page, entry.checkbox);
		await page.keyboard.press("Space");
		await expect(entry.checkbox).toBeChecked();
	}
}

async function submitCollectionByKeyboard(
	page: Page,
	expectedTotal: number,
	expectedInvoiceCount: number,
) {
	await expect(
		page.getByText(`${expectedInvoiceCount} invoice(s)`, { exact: true }),
	).toBeVisible({
		timeout: 30_000,
	});
	const amountInput = page.locator(".payment-amount-input input").first();
	await keyboardReplace(page, amountInput, String(expectedTotal));
	const responsePromise = page.waitForResponse(
		responseFor("process_pos_payment"),
		{
			timeout: CLOSE_TIMEOUT_MS,
		},
	);
	await keyboardActivate(
		page,
		page
			.getByRole("button", { name: "Submit", exact: true })
			.filter({ visible: true }),
	);
	const body = await (await responsePromise).json().catch(() => ({}));
	const paymentEntry = String(
		body?.message?.new_payments_entry?.[0]?.name || "",
	);
	expect(paymentEntry, JSON.stringify(body).slice(0, 1000)).toBeTruthy();
	await expect(amountInput).toHaveValue("0", { timeout: CLOSE_TIMEOUT_MS });
	return paymentEntry;
}

async function invoiceOutstanding(page: Page, invoiceNames: string[]) {
	const rows = await callFrappe<Array<Record<string, any>>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "Sales Invoice",
			filters: [["name", "in", invoiceNames]],
			fields: ["name", "docstatus", "outstanding_amount", "status"],
			limit_page_length: Math.max(invoiceNames.length, 1),
		},
	);
	return new Map(
		rows.map((row) => [String(row.name), asNumber(row.outstanding_amount)]),
	);
}

async function waitForOutstanding(
	page: Page,
	invoiceNames: string[],
	expected: "zero" | "positive",
) {
	let latest = new Map<string, number>();
	await expect
		.poll(
			async () => {
				latest = await invoiceOutstanding(page, invoiceNames);
				if (latest.size !== invoiceNames.length) return false;
				return [...latest.values()].every((value) =>
					expected === "zero"
						? Math.abs(value) <= 0.001
						: value > 0.001,
				);
			},
			{ timeout: CLOSE_TIMEOUT_MS, intervals: [500, 1000, 2000] },
		)
		.toBe(true);
	return latest;
}

async function attachEvidence(
	testInfo: TestInfo,
	evidence: Record<string, unknown>,
) {
	const path = testInfo.outputPath(
		"pos-credit-keyboard-acceptance-report.json",
	);
	await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	await testInfo.attach("pos-credit-keyboard-acceptance-report", {
		path,
		contentType: "application/json",
	});
}

test("creates and settles 100 Vital Pharmacy credit sales by keyboard", async ({
	page,
}, testInfo) => {
	test.setTimeout(6 * 60 * 60_000);
	const resumeEvidence = RESUME_REPORT_PATH
		? JSON.parse(await readFile(RESUME_REPORT_PATH, "utf8"))
		: RESUME_CASHIER
			? { databaseCashier: RESUME_CASHIER }
			: null;
	expect(FIRST_COLLECTION_COUNT).toBeLessThan(SALE_COUNT);
	await page.setViewportSize({ width: 1440, height: 900 });
	const evidence: Record<string, any> = {
		startedAt: new Date().toISOString(),
		profile: POS_PROFILE,
		customer: CUSTOMER,
		itemCode: ITEM_CODE,
		requestedSales: SALE_COUNT,
		firstCollectionCount: FIRST_COLLECTION_COUNT,
		creditSales: (resumeEvidence?.creditSales ||
			[]) as CreditSaleEvidence[],
		openingShifts: [] as string[],
		closingShifts: [] as string[],
		paymentEntries: [] as string[],
		globalErrors: [] as string[],
		pointerActions: [] as Array<Record<string, unknown>>,
	};
	let cashier: TemporaryCashier | null = null;
	const pageErrorListener = (error: Error) => {
		evidence.globalErrors.push(`pageerror: ${error.message}`);
	};
	const consoleListener = (message: {
		type: () => string;
		text: () => string;
	}) => {
		if (message.type() === "error") {
			const text = message.text();
			if (!text.toLowerCase().includes("shortcut.js")) {
				evidence.globalErrors.push(`console.error: ${text}`);
			}
		}
	};
	page.on("pageerror", pageErrorListener);
	page.on("console", consoleListener);

	try {
		await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
		if (/\/login/.test(page.url())) {
			throw new Error(
				"Credit keyboard acceptance requires POSA_SMOKE_SID.",
			);
		}
		await waitForPosReady(page);
		const profile = await callFrappe<Record<string, any>>(
			page,
			"frappe.client.get",
			{ doctype: "POS Profile", name: POS_PROFILE },
		);
		expect(asNumber(profile.disabled)).toBe(0);
		expect(asNumber(profile.posa_allow_credit_sale)).toBe(1);
		expect(asNumber(profile.posa_allow_make_new_payments)).toBe(1);
		expect(asNumber(profile.posa_allow_reconcile_payments)).toBe(1);
		expect(
			asNumber(profile.create_pos_invoice_instead_of_sales_invoice),
		).toBe(1);
		expect(profile.warehouse).toBeTruthy();
		expect(
			(profile.payments || []).some((row: any) => row.mode_of_payment),
		).toBe(true);
		const customer = await callFrappe<Record<string, any>>(
			page,
			"frappe.client.get",
			{ doctype: "Customer", name: CUSTOMER },
		);
		expect(asNumber(customer.disabled)).toBe(0);
		let databaseResumeTargets: string[] = [];
		if (resumeEvidence?.databaseCashier) {
			const sourceInvoices = await callFrappe<Array<Record<string, any>>>(
				page,
				"frappe.client.get_list",
				{
					doctype: "POS Invoice",
					filters: {
						posa_cashier: resumeEvidence.databaseCashier,
						customer: CUSTOMER,
						docstatus: 1,
					},
					fields: [
						"name",
						"posa_client_request_id",
						"due_date",
						"grand_total",
						"outstanding_amount",
						"consolidated_invoice",
					],
					order_by: "name asc",
					limit_page_length: SALE_COUNT + 10,
				},
			);
			expect(sourceInvoices).toHaveLength(SALE_COUNT);
			evidence.creditSales = sourceInvoices.map((invoice, index) => ({
				sale: index + 1,
				posInvoice: String(invoice.name),
				requestId: String(invoice.posa_client_request_id || ""),
				dueDate: String(invoice.due_date || ""),
				grandTotal: asNumber(invoice.grand_total),
				outstandingAmount: asNumber(invoice.outstanding_amount),
				ledgerState: "POST_SUBMIT_DONE",
				consolidatedInvoice: String(invoice.consolidated_invoice || ""),
			}));
			databaseResumeTargets = evidence.creditSales.map(
				(sale: CreditSaleEvidence) => String(sale.consolidatedInvoice),
			);
			expect(databaseResumeTargets.every(Boolean)).toBe(true);
		}
		let exposureBefore = resumeEvidence?.customerExposureBefore
			? resumeEvidence.customerExposureBefore
			: await callFrappe<Record<string, any>>(
					page,
					"posawesome.posawesome.api.credit_sales.get_credit_sale_context",
					{
						customer: CUSTOMER,
						company: profile.company,
						pos_profile: POS_PROFILE,
						proposed_credit_amount: 0,
					},
				);
		if (databaseResumeTargets.length) {
			const targetOutstanding = await invoiceOutstanding(
				page,
				databaseResumeTargets,
			);
			const targetTotal = [...targetOutstanding.values()].reduce(
				(total, amount) => total + amount,
				0,
			);
			expect(targetOutstanding.size).toBe(SALE_COUNT);
			expect(targetTotal).toBeGreaterThan(0);
			exposureBefore = {
				...exposureBefore,
				ledger_outstanding:
					asNumber(exposureBefore.ledger_outstanding) - targetTotal,
				current_outstanding:
					asNumber(exposureBefore.current_outstanding) - targetTotal,
				projected_outstanding:
					asNumber(exposureBefore.projected_outstanding) -
					targetTotal,
			};
		}
		evidence.customerExposureBefore = exposureBefore;
		expect(exposureBefore.eligible).toBe(true);
		const preexistingOutstanding = resumeEvidence?.preexistingOutstanding
			? resumeEvidence.preexistingOutstanding
			: await callFrappe<Array<Record<string, any>>>(
					page,
					"frappe.client.get_list",
					{
						doctype: "Sales Invoice",
						filters: [
							["customer", "=", CUSTOMER],
							["company", "=", profile.company],
							["docstatus", "=", 1],
							["outstanding_amount", ">", 0],
						],
						fields: ["name", "outstanding_amount"],
						limit_page_length: 500,
					},
				);
		if (databaseResumeTargets.length) {
			const targetSet = new Set(databaseResumeTargets);
			for (
				let index = preexistingOutstanding.length - 1;
				index >= 0;
				index -= 1
			) {
				if (
					targetSet.has(String(preexistingOutstanding[index]?.name))
				) {
					preexistingOutstanding.splice(index, 1);
				}
			}
		}
		evidence.preexistingOutstanding = preexistingOutstanding;
		const preexistingOutstandingByName = new Map(
			preexistingOutstanding.map((row) => [
				String(row.name),
				asNumber(row.outstanding_amount),
			]),
		);
		let stockBeforeAll = resumeEvidence?.stockBeforeAll
			? resumeEvidence.stockBeforeAll
			: await captureStock(page, ITEM_CODE, profile.warehouse);
		if (databaseResumeTargets.length) {
			stockBeforeAll = {
				...stockBeforeAll,
				availableQty: stockBeforeAll.availableQty + SALE_COUNT,
				binActualQty: stockBeforeAll.binActualQty + SALE_COUNT,
			};
		}
		evidence.stockBeforeAll = stockBeforeAll;
		expect(stockBeforeAll.availableQty).toBeGreaterThan(SALE_COUNT + 10);

		evidence.orphanedTemporarySupervisorsCleaned =
			await cleanupOrphanedTemporarySupervisors(page, POS_PROFILE);
		cashier = await provisionTemporarySupervisor(page, POS_PROFILE);
		evidence.cashier = cashier.user;
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForPosReady(page);
		await expect(
			page.locator('[data-test="terminal-lock-dialog"]'),
		).toBeHidden({
			timeout: 30_000,
		});
		await startPointerAudit(page);
		await page.evaluate(() => {
			(window as any).__creditKeyboardResponses = [];
			window.addEventListener(
				"posa:invoice-submit-response",
				(event: Event) => {
					(window as any).__creditKeyboardResponses.push(
						(event as CustomEvent).detail,
					);
				},
			);
		});

		evidence.openingShifts.push(
			await ensureOpenShiftByKeyboard(page, POS_PROFILE),
		);
		await expect(page.locator('[data-test="pos-navbar"]')).toHaveAttribute(
			"data-pos-profile",
			POS_PROFILE,
			{ timeout: 90_000 },
		);
		let stockBefore = stockBeforeAll;
		if (!resumeEvidence) {
			for (let sale = 1; sale <= SALE_COUNT; sale += 1) {
				if (sale > 1) {
					await expect(
						page.locator(".customer-autocomplete").first(),
					).toContainText(String(profile.customer), {
						timeout: 30_000,
					});
				}
				const due = new Date();
				due.setDate(due.getDate() + sale);
				const dueDate = formatDate(due);
				await selectCustomerByKeyboard(page, CUSTOMER);
				await expect
					.poll(
						async () => {
							const text = await page
								.getByTestId("counter-grid-customer-balance")
								.textContent();
							return asNumber(
								String(text || "").replace(/[^0-9.-]/g, ""),
							);
						},
						{ timeout: 30_000 },
					)
					.toBeGreaterThan(0);
				const searchLatencyMs = await addItemByKeyboard(
					page,
					ITEM_CODE,
				);
				await expect(
					page.locator(".customer-autocomplete").first(),
				).toContainText(CUSTOMER, { timeout: 30_000 });
				const submitted = await submitCreditSaleByKeyboard(
					page,
					cashier.pin,
					dueDate,
				);
				const ledgerState = await waitForFinalLedger(
					page,
					submitted.requestId,
					submitted.invoice,
				);
				const invoice = await callFrappe<Record<string, any>>(
					page,
					"frappe.client.get",
					{ doctype: "POS Invoice", name: submitted.invoice },
				);
				expect(asNumber(invoice.docstatus)).toBe(1);
				expect(asNumber(invoice.posa_is_credit_sale)).toBe(1);
				expect(invoice.customer).toBe(CUSTOMER);
				expect(invoice.due_date).toBe(dueDate);
				expect(asNumber(invoice.outstanding_amount)).toBeGreaterThan(0);
				expect(
					(invoice.payments || []).reduce(
						(total: number, row: any) =>
							total + asNumber(row.amount),
						0,
					),
				).toBe(0);
				const stockAfter = await captureStock(
					page,
					ITEM_CODE,
					profile.warehouse,
				);
				const availableDelta =
					stockAfter.availableQty - stockBefore.availableQty;
				const saleEvidence: CreditSaleEvidence = {
					sale,
					posInvoice: submitted.invoice,
					requestId: submitted.requestId,
					dueDate,
					grandTotal: asNumber(invoice.grand_total),
					outstandingAmount: asNumber(invoice.outstanding_amount),
					ledgerState,
					stockBefore,
					stockAfter,
					availableDelta,
					deltaMatches: Math.abs(availableDelta + 1) <= 0.001,
					searchLatencyMs,
					signingLatencyMs: submitted.signingLatencyMs,
					submissionLatencyMs: submitted.submissionLatencyMs,
				};
				expect(saleEvidence.deltaMatches).toBe(true);
				evidence.creditSales.push(saleEvidence);
				stockBefore = stockAfter;
				if (sale % 10 === 0) {
					console.log(
						`[pos-credit-keyboard] ${sale}/${SALE_COUNT} credit sales`,
					);
				}
			}
		}

		const consolidatedNames: string[] = [];
		if (!resumeEvidence) {
			evidence.closingShifts.push(await closeShiftByKeyboard(page));
			for (const sale of evidence.creditSales as CreditSaleEvidence[]) {
				const source = await callFrappe<Record<string, any>>(
					page,
					"frappe.client.get",
					{
						doctype: "POS Invoice",
						name: sale.posInvoice,
					},
				);
				sale.consolidatedInvoice = String(
					source.consolidated_invoice || "",
				);
				expect(sale.consolidatedInvoice).toBeTruthy();
				consolidatedNames.push(sale.consolidatedInvoice);
			}
		} else {
			evidence.resumedFrom = RESUME_REPORT_PATH;
			for (const sale of evidence.creditSales as CreditSaleEvidence[]) {
				expect(sale.consolidatedInvoice).toBeTruthy();
				consolidatedNames.push(String(sale.consolidatedInvoice));
			}
		}
		expect(new Set(consolidatedNames).size).toBe(SALE_COUNT);
		await waitForOutstanding(page, consolidatedNames, "positive");

		if (!resumeEvidence) {
			evidence.openingShifts.push(await openShiftByKeyboard(page));
		}
		const firstGroup = consolidatedNames.slice(0, FIRST_COLLECTION_COUNT);
		const remainingGroup = consolidatedNames.slice(FIRST_COLLECTION_COUNT);
		const outstandingBeforeCollection = await invoiceOutstanding(
			page,
			consolidatedNames,
		);
		const firstTotal = firstGroup.reduce(
			(total, name) =>
				total + asNumber(outstandingBeforeCollection.get(name)),
			0,
		);
		const remainingTotal = remainingGroup.reduce(
			(total, name) =>
				total + asNumber(outstandingBeforeCollection.get(name)),
			0,
		);
		evidence.collectionPlan = {
			firstInvoices: firstGroup,
			firstTotal,
			remainingInvoices: remainingGroup,
			remainingTotal,
		};

		await openFirstInvoicePaymentFromCounter(page, firstGroup[0]);
		let invoiceTable = await showAllPaymentInvoicesByKeyboard(
			page,
			SALE_COUNT,
		);
		await selectInvoiceGroupByKeyboard(
			page,
			invoiceTable,
			firstGroup,
			new Set([firstGroup[0]]),
		);
		evidence.paymentEntries.push(
			await submitCollectionByKeyboard(
				page,
				firstTotal,
				FIRST_COLLECTION_COUNT,
			),
		);
		await waitForOutstanding(page, firstGroup, "zero");
		await waitForOutstanding(page, remainingGroup, "positive");
		evidence.firstCollectionVerifiedAt = new Date().toISOString();

		invoiceTable = await showAllPaymentInvoicesByKeyboard(
			page,
			remainingGroup.length,
		);
		await selectInvoiceGroupByKeyboard(page, invoiceTable, remainingGroup);
		evidence.paymentEntries.push(
			await submitCollectionByKeyboard(
				page,
				remainingTotal,
				remainingGroup.length,
			),
		);
		await waitForOutstanding(page, consolidatedNames, "zero");
		evidence.allCollectionsVerifiedAt = new Date().toISOString();

		const exposureAfter = await callFrappe<Record<string, any>>(
			page,
			"posawesome.posawesome.api.credit_sales.get_credit_sale_context",
			{
				customer: CUSTOMER,
				company: profile.company,
				pos_profile: POS_PROFILE,
				proposed_credit_amount: 0,
			},
		);
		evidence.customerExposureAfter = exposureAfter;
		expect(asNumber(exposureAfter.current_outstanding)).toBe(
			asNumber(exposureBefore.current_outstanding),
		);
		const preexistingAfter = await invoiceOutstanding(page, [
			...preexistingOutstandingByName.keys(),
		]);
		expect(preexistingAfter.size).toBe(preexistingOutstandingByName.size);
		for (const [name, amount] of preexistingOutstandingByName) {
			expect(asNumber(preexistingAfter.get(name))).toBe(amount);
		}
		await keyboardActivate(
			page,
			page.getByRole("button", { name: "Toggle navigation drawer" }),
		);
		await keyboardActivate(
			page,
			page.getByRole("link", { name: "POS", exact: true }),
		);
		await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
			timeout: 30_000,
		});
		evidence.closingShifts.push(await closeShiftByKeyboard(page));
		const stockAfterAll = await captureStock(
			page,
			ITEM_CODE,
			profile.warehouse,
		);
		evidence.stockAfterAll = stockAfterAll;
		expect(stockAfterAll.availableQty - stockBeforeAll.availableQty).toBe(
			-SALE_COUNT,
		);

		evidence.pointerActions = await page.evaluate(
			() => (window as any).__creditKeyboardPointerActions || [],
		);
		expect(evidence.pointerActions).toEqual([]);
		expect(evidence.globalErrors).toEqual([]);
		evidence.latency = resumeEvidence
			? { resumedSettlement: true }
			: {
					search: latencySummary(
						evidence.creditSales.map(
							(sale: CreditSaleEvidence) => sale.searchLatencyMs,
						),
					),
					signing: latencySummary(
						evidence.creditSales.map(
							(sale: CreditSaleEvidence) => sale.signingLatencyMs,
						),
					),
					submission: latencySummary(
						evidence.creditSales.map(
							(sale: CreditSaleEvidence) =>
								sale.submissionLatencyMs,
						),
					),
				};
		evidence.finishedAt = new Date().toISOString();
	} finally {
		evidence.pointerActions = await page
			.evaluate(
				() => (window as any).__creditKeyboardPointerActions || [],
			)
			.catch(() => evidence.pointerActions || []);
		if (cashier && !page.isClosed()) {
			await cleanupTemporarySupervisor(page, POS_PROFILE, cashier).catch(
				(error) => {
					evidence.cleanupError = String(error?.message || error);
				},
			);
		}
		evidence.finishedAt ||= new Date().toISOString();
		await attachEvidence(testInfo, evidence);
		page.off("pageerror", pageErrorListener);
		page.off("console", consoleListener);
	}
});
