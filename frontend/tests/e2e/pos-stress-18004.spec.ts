import { expect, test, type Page } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
	getProvisionedTerminalCashier,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_STRESS_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const SUBMIT_METHOD = "posawesome.posawesome.api.invoices.submit_invoice";
const STOCK_METHOD =
	"posawesome.posawesome.api.item_processing.stock.get_available_qty";
const POS_PROFILE = "MedPlus POS 1 - Supervisor";
const WAREHOUSE = "Main Store - MP";
const ITEM_CODES = [
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
const INVOICE_COUNT = 30;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 45_000;

test.skip(
	!ENABLED,
	"Set POSA_STRESS_E2E=1 to run the destructive POS stress test.",
);

type SubmissionPayload = {
	data: Record<string, any>;
	invoice: Record<string, any>;
	cashier_pin: string;
};

async function callFrappe<T = any>(
	page: Page,
	method: string,
	args: Record<string, unknown> = {},
) {
	return page.evaluate(
		async ({ callMethod, callArgs, timeoutMs }) => {
			const describeError = (error: any) => {
				const body =
					error?.responseJSON ||
					error?.xhr?.responseJSON ||
					error?.response ||
					error ||
					{};
				const parts = [
					body?.exception,
					body?.exc_type,
					body?._server_messages,
					body?.message,
					error?.message,
					typeof error === "string" ? error : "",
				].filter(Boolean);
				return parts.join(" | ") || "Unknown Frappe request failure";
			};
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
				return response?.message as T;
			} catch (error) {
				throw new Error(`${callMethod}: ${describeError(error)}`);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		},
		{ callMethod: method, callArgs: args, timeoutMs: REQUEST_TIMEOUT_MS },
	);
}

function asNumber(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number) {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clearDocumentIdentity(row: Record<string, any>) {
	for (const field of [
		"name",
		"owner",
		"creation",
		"modified",
		"modified_by",
		"parent",
		"parentfield",
		"parenttype",
		"_liked_by",
		"_comments",
		"_assign",
		"_user_tags",
	]) {
		delete row[field];
	}
	row.docstatus = 0;
}

async function findFixtureInvoice(page: Page) {
	const rows = await callFrappe<Array<{ name: string }>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "POS Invoice",
			filters: [
				["docstatus", "=", 1],
				["pos_profile", "=", POS_PROFILE],
			],
			fields: ["name"],
			order_by: "creation desc",
			limit_page_length: 60,
		},
	);
	for (let offset = 0; offset < rows.length; offset += 6) {
		const documents = await Promise.all(
			rows.slice(offset, offset + 6).map((row) =>
				callFrappe<Record<string, any>>(page, "frappe.client.get", {
					doctype: "POS Invoice",
					name: row.name,
				}),
			),
		);
		const fixture = documents.find((document) => {
			const itemCodes = new Set(
				(document.items || []).map(
					(item: Record<string, any>) => item.item_code,
				),
			);
			return ITEM_CODES.every((itemCode) => itemCodes.has(itemCode));
		});
		if (fixture) return fixture;
	}
	throw new Error(
		`No submitted ${POS_PROFILE} invoice contains all stress-test items.`,
	);
}

async function getActiveOpeningShift(page: Page) {
	const shifts = await callFrappe<Array<{ name: string }>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "POS Opening Shift",
			filters: [
				["docstatus", "=", 1],
				["status", "=", "Open"],
				["pos_profile", "=", POS_PROFILE],
				["user", "=", "Administrator"],
			],
			fields: ["name"],
			order_by: "period_start_date desc",
			limit_page_length: 1,
		},
	);
	expect(shifts).toHaveLength(1);
	return shifts[0].name;
}

async function getAvailability(page: Page) {
	const rows = await callFrappe<
		Array<{ item_code: string; available_qty: number }>
	>(page, STOCK_METHOD, {
		items: ITEM_CODES.map((itemCode) => ({
			item_code: itemCode,
			warehouse: WAREHOUSE,
		})),
	});
	return Object.fromEntries(
		rows.map((row) => [row.item_code, asNumber(row.available_qty)]),
	);
}

function prepareBasePayload(
	fixture: Record<string, any>,
	openingShift: string,
	cashierPin: string,
	today: string,
): SubmissionPayload {
	const invoice = structuredClone(fixture);
	clearDocumentIdentity(invoice);
	for (const field of [
		"status",
		"consolidated_invoice",
		"return_against",
		"amended_from",
		"posa_client_request_id",
	]) {
		delete invoice[field];
	}
	invoice.doctype = "POS Invoice";
	invoice.is_pos = 1;
	invoice.is_return = 0;
	invoice.update_stock = 1;
	invoice.posting_date = today;
	invoice.set_posting_time = 0;
	invoice.posa_pos_opening_shift = openingShift;
	invoice.advances = [];
	invoice.packed_items = [];
	invoice.pricing_rules = [];
	invoice.taxes = [];
	invoice.items = ITEM_CODES.map((itemCode, index) => {
		const source = (fixture.items || []).find(
			(item: Record<string, any>) => item.item_code === itemCode,
		);
		if (!source) throw new Error(`Fixture is missing ${itemCode}.`);
		const item = structuredClone(source);
		clearDocumentIdentity(item);
		item.idx = index + 1;
		return item;
	});
	invoice.payments = (fixture.payments || [])
		.filter(
			(payment: Record<string, any>) =>
				payment.mode_of_payment === "Cash",
		)
		.slice(0, 1)
		.map((payment: Record<string, any>) => {
			const row = structuredClone(payment);
			clearDocumentIdentity(row);
			row.idx = 1;
			return row;
		});
	expect(invoice.payments).toHaveLength(1);
	return {
		invoice,
		data: {
			doctype: "POS Invoice",
			company: invoice.company,
			customer: invoice.customer,
			pos_profile: invoice.pos_profile,
			posa_pos_opening_shift: openingShift,
		},
		cashier_pin: cashierPin,
	};
}

function buildPayload(
	base: SubmissionPayload,
	requestId: string,
	itemCount: number,
	rotation: number,
) {
	const payload: SubmissionPayload = structuredClone(base);
	const sourceItems = base.invoice.items || [];
	const selected = Array.from({ length: itemCount }, (_, index) =>
		structuredClone(sourceItems[(rotation + index) % sourceItems.length]),
	);
	selected.forEach((item, index) => {
		clearDocumentIdentity(item);
		const rate = asNumber(item.rate);
		const baseRate = asNumber(item.base_rate || item.rate);
		const conversionFactor = asNumber(item.conversion_factor) || 1;
		item.idx = index + 1;
		item.qty = 1;
		item.stock_qty = conversionFactor;
		item.rate = rate;
		item.net_rate = rate;
		item.amount = rate;
		item.net_amount = rate;
		item.base_rate = baseRate;
		item.base_net_rate = baseRate;
		item.base_amount = baseRate;
		item.base_net_amount = baseRate;
		item.discount_amount = 0;
		item.base_discount_amount = 0;
		item.discount_percentage = 0;
	});

	const total = money(
		selected.reduce((sum, item) => sum + asNumber(item.net_amount), 0),
	);
	const baseTotal = money(
		selected.reduce((sum, item) => sum + asNumber(item.base_net_amount), 0),
	);
	const roundedTotal = Math.round(total);
	const baseRoundedTotal = Math.round(baseTotal);
	expect(total).toBeGreaterThan(0);

	payload.invoice.items = selected;
	payload.invoice.total_qty = itemCount;
	payload.invoice.total = total;
	payload.invoice.net_total = total;
	payload.invoice.base_total = baseTotal;
	payload.invoice.base_net_total = baseTotal;
	payload.invoice.total_taxes_and_charges = 0;
	payload.invoice.base_total_taxes_and_charges = 0;
	payload.invoice.discount_amount = 0;
	payload.invoice.base_discount_amount = 0;
	payload.invoice.additional_discount_percentage = 0;
	payload.invoice.grand_total = total;
	payload.invoice.base_grand_total = baseTotal;
	payload.invoice.rounded_total = roundedTotal;
	payload.invoice.base_rounded_total = baseRoundedTotal;
	payload.invoice.rounding_adjustment = money(roundedTotal - total);
	payload.invoice.base_rounding_adjustment = money(
		baseRoundedTotal - baseTotal,
	);
	payload.invoice.paid_amount = roundedTotal;
	payload.invoice.base_paid_amount = baseRoundedTotal;
	payload.invoice.outstanding_amount = 0;
	payload.invoice.change_amount = 0;
	payload.invoice.base_change_amount = 0;
	payload.invoice.total_advance = 0;
	payload.invoice.write_off_amount = 0;
	payload.invoice.base_write_off_amount = 0;
	payload.invoice.posa_client_request_id = requestId;
	payload.invoice.payments = payload.invoice.payments.map(
		(payment: Record<string, any>, index: number) => {
			clearDocumentIdentity(payment);
			return {
				...payment,
				idx: index + 1,
				amount: payment.mode_of_payment === "Cash" ? roundedTotal : 0,
				base_amount:
					payment.mode_of_payment === "Cash" ? baseRoundedTotal : 0,
			};
		},
	);
	payload.data.client_request_id = requestId;
	payload.data.idempotency_key = requestId;
	return payload;
}

test("submits thirty unique signed 3-10 item POS invoices", async ({
	page,
}) => {
	test.setTimeout(20 * 60_000);
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 120_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 120_000,
	});
	await ensureAuthoritativeTerminalUnlock(page);
	const cashier = getProvisionedTerminalCashier(page);
	if (!cashier?.pin) {
		throw new Error("The stress run requires a provisioned cashier PIN.");
	}

	const runId = `e2e-stress-${Date.now()}`;
	const startedAt = Date.now();
	const fixture = await findFixtureInvoice(page);
	const openingShift = await getActiveOpeningShift(page);
	const today = await page.evaluate(() =>
		(window as any).frappe.datetime.get_today(),
	);
	const base = prepareBasePayload(fixture, openingShift, cashier.pin, today);
	const stockBefore = await getAvailability(page);
	for (const itemCode of ITEM_CODES) {
		expect(stockBefore[itemCode]).toBeGreaterThan(0);
	}

	const jobs = Array.from({ length: INVOICE_COUNT }, (_, index) => {
		const itemCount = 3 + (index % 8);
		const requestId = `${runId}-${String(index + 1).padStart(2, "0")}`;
		return {
			requestId,
			itemCount,
			payload: buildPayload(base, requestId, itemCount, index),
		};
	});
	const acknowledgements: Array<Record<string, any>> = [];
	for (let offset = 0; offset < jobs.length; offset += CONCURRENCY) {
		const wave = jobs.slice(offset, offset + CONCURRENCY);
		const waveStartedAt = Date.now();
		const results = await Promise.all(
			wave.map(async ({ payload, requestId, itemCount }) => {
				const response = await callFrappe<Record<string, any>>(
					page,
					SUBMIT_METHOD,
					{
						invoice: payload.invoice,
						data: payload.data,
						submit_in_background: 0,
						cashier_pin: payload.cashier_pin,
					},
				);
				expect(response?.name).toBeTruthy();
				expect(response?.docstatus).toBe(1);
				expect(response?.client_request_id).toBe(requestId);
				return { ...response, requestId, itemCount };
			}),
		);
		acknowledgements.push(...results);
		console.log(
			`[stress] ${acknowledgements.length}/${INVOICE_COUNT} acknowledged in ${Date.now() - waveStartedAt}ms`,
		);
	}

	expect(new Set(acknowledgements.map((row) => row.name)).size).toBe(
		INVOICE_COUNT,
	);
	expect(
		new Set(acknowledgements.map((row) => row.client_request_id)).size,
	).toBe(INVOICE_COUNT);

	const replay = await callFrappe<Record<string, any>>(page, SUBMIT_METHOD, {
		invoice: jobs[0].payload.invoice,
		data: jobs[0].payload.data,
		submit_in_background: 0,
		cashier_pin: jobs[0].payload.cashier_pin,
	});
	expect(replay.name).toBe(acknowledgements[0].name);
	expect(replay.replayed || replay.idempotent).toBeTruthy();

	const serverRows = await callFrappe<Array<Record<string, any>>>(
		page,
		"frappe.client.get_list",
		{
			doctype: "POS Invoice",
			filters: [
				["posa_client_request_id", "like", `${runId}%`],
				["docstatus", "=", 1],
			],
			fields: [
				"name",
				"docstatus",
				"status",
				"posa_client_request_id",
				"paid_amount",
				"update_stock",
			],
			limit_page_length: INVOICE_COUNT + 5,
		},
	);
	expect(serverRows).toHaveLength(INVOICE_COUNT);
	expect(
		new Set(serverRows.map((row) => row.posa_client_request_id)).size,
	).toBe(INVOICE_COUNT);
	for (const row of serverRows) {
		expect(row.docstatus).toBe(1);
		expect(asNumber(row.paid_amount)).toBeGreaterThan(0);
		expect(asNumber(row.update_stock)).toBe(1);
	}

	const expectedReserved = Object.fromEntries(
		ITEM_CODES.map((itemCode) => [
			itemCode,
			jobs.reduce(
				(total, job) =>
					total +
					job.payload.invoice.items.filter(
						(item: Record<string, any>) =>
							item.item_code === itemCode,
					).length,
				0,
			),
		]),
	);
	const stockAfter = await getAvailability(page);
	for (const itemCode of ITEM_CODES) {
		expect(money(stockBefore[itemCode] - stockAfter[itemCode])).toBe(
			expectedReserved[itemCode],
		);
	}

	console.log(
		`[stress] completed ${INVOICE_COUNT} invoices / ${jobs.reduce(
			(sum, job) => sum + job.itemCount,
			0,
		)} lines in ${Date.now() - startedAt}ms; run=${runId}; fixture=${fixture.name}; shift=${openingShift}; cashier=${cashier.user}`,
	);
});

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page);
});
