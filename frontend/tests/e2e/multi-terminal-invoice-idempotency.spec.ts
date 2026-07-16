import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const ENABLED = process.env.POSA_MULTI_TERMINAL_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const ITEM_CODE = process.env.POSA_COUNTER_GRID_PERF_ITEM || "02017";
const EXPECTED_PROFILE =
	process.env.POSA_COUNTER_GRID_POS_PROFILE || "POS Awesome - MedPlus";
const CASHIER_PIN = process.env.POSA_E2E_CASHIER_PIN || "";
const SUBMIT_METHOD = "posawesome.posawesome.api.invoices.submit_invoice";

test.skip(
	!ENABLED,
	"Set POSA_MULTI_TERMINAL_E2E=1 to run the authenticated multi-terminal idempotency test.",
);

type InvoicePayload = Record<string, any>;
type SubmissionPayload = {
	data: Record<string, any>;
	invoice: InvoicePayload;
	cashier_pin: string;
};
type SubmissionResponse = {
	name: string;
	doctype: string;
	docstatus: number;
	client_request_id: string;
	replayed?: boolean;
};

async function callFrappe<T = any>(
	page: Page,
	method: string,
	args: Record<string, unknown> = {},
) {
	return page.evaluate(
		({ callMethod, callArgs }) =>
			new Promise<T>((resolve, reject) => {
				(window as any).frappe.call({
					method: callMethod,
					args: callArgs,
					callback: (response: any) =>
						resolve(response?.message as T),
					error: (error: any) =>
						reject(
							new Error(
								error?.responseJSON?._server_messages ||
									error?.responseJSON?.exception ||
									error?.statusText ||
									"Frappe request failed",
							),
						),
				});
			}),
		{ callMethod: method, callArgs: args },
	);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
) {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(
					() => reject(new Error(message)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

async function waitForPos(page: Page) {
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Multi-terminal E2E requires POSA_SMOKE_SID or login credentials.",
		);
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

async function addSingleItem(page: Page) {
	const entry = page.getByTestId("counter-grid-item-entry");
	await entry.fill(ITEM_CODE);
	await entry.press("Enter");
	const search = page.getByTestId("pos-item-search").locator("input");
	await expect(search).toBeFocused({ timeout: 15_000 });
	await expect(
		page.locator(".items-selector-shell--counter-dialog"),
	).toHaveAttribute("data-search-ready-query", ITEM_CODE, {
		timeout: 30_000,
	});
	const result = page.getByTestId(`pos-item-row-${ITEM_CODE}`);
	await expect(result).toBeVisible({ timeout: 30_000 });
	await search.press("Enter");
	await expect(page.getByTestId(`cart-row-${ITEM_CODE}`).first()).toBeVisible(
		{
			timeout: 30_000,
		},
	);
}

async function captureSubmissionPayload(page: Page) {
	await page.getByTestId("payment-submit").click();
	const signingDialog = page.getByTestId("cashier-sale-signing-dialog");
	await expect(signingDialog).toBeVisible({ timeout: 15_000 });
	const pinInput = signingDialog
		.getByTestId("cashier-sale-pin-input")
		.locator("input");
	await expect(pinInput).toBeFocused();
	const paymentMethods = signingDialog.getByTestId(
		"cashier-sale-payment-method",
	);
	const labels = await paymentMethods.locator("span").allTextContents();
	const cashIndex = labels.indexOf("Cash");
	expect(
		cashIndex,
		`${EXPECTED_PROFILE} must expose the exact Cash payment method.`,
	).toBeGreaterThanOrEqual(0);
	await paymentMethods.nth(cashIndex).click();
	await pinInput.fill(CASHIER_PIN);
	await pinInput.focus();

	await page.evaluate((submitMethod) => {
		const scope = window as any;
		const originalCall = scope.frappe.call.bind(scope.frappe);
		scope.__posaOriginalFrappeCall = originalCall;
		scope.__posaCapturedSubmission = null;
		scope.frappe.call = (options: any) => {
			if (options?.method !== submitMethod) {
				return originalCall(options);
			}
			scope.__posaCapturedSubmission = JSON.parse(
				JSON.stringify(options.args || {}),
			);
			queueMicrotask(() =>
				options.error?.({
					status: 0,
					statusText: "Payload captured for idempotency test",
				}),
			);
			return { abort: () => undefined };
		};
	}, SUBMIT_METHOD);

	await pinInput.press("Enter");
	await expect
		.poll(
			() =>
				page.evaluate(() =>
					Boolean((window as any).__posaCapturedSubmission),
				),
			{ timeout: 90_000 },
		)
		.toBe(true);

	const payload = await page.evaluate<SubmissionPayload>(() => {
		const scope = window as any;
		const captured = scope.__posaCapturedSubmission;
		scope.frappe.call = scope.__posaOriginalFrappeCall;
		delete scope.__posaOriginalFrappeCall;
		delete scope.__posaCapturedSubmission;
		return captured;
	});
	return payload;
}

async function removeOutboxEntry(page: Page, requestId: string) {
	await page.evaluate(async (clientRequestId) => {
		localStorage.removeItem(
			`posa_invoice_intent_${encodeURIComponent(clientRequestId)}`,
		);
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("posawesome_offline");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			if (!database.objectStoreNames.contains("invoice_outbox")) return;
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(
					"invoice_outbox",
					"readwrite",
				);
				const store = transaction.objectStore("invoice_outbox");
				const keyRequest = store
					.index("client_request_id")
					.getKey(clientRequestId);
				keyRequest.onsuccess = () => {
					if (keyRequest.result !== undefined) {
						store.delete(keyRequest.result);
					}
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally {
			database.close();
		}
	}, requestId);
}

async function openTerminal(context: BrowserContext) {
	const terminal = await context.newPage();
	await terminal.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(terminal.url())) {
		throw new Error("The cloned terminal context is not authenticated.");
	}
	await expect
		.poll(
			() =>
				terminal.evaluate(() => Boolean((window as any).frappe?.call)),
			{ timeout: 90_000 },
		)
		.toBe(true);
	return terminal;
}

async function submitUntilResolved(
	page: Page,
	clientRequestId: string,
	payload: SubmissionPayload,
) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await withTimeout(
				callFrappe<SubmissionResponse>(page, SUBMIT_METHOD, {
					invoice: payload.invoice,
					data: payload.data,
					submit_in_background: 0,
					cashier_pin: payload.cashier_pin,
				}),
				12_000,
				`Signed submission timed out for ${clientRequestId}`,
			);
			if (
				response?.client_request_id === clientRequestId &&
				response.name
			)
				return response;
			lastError = new Error("Signed submission was not acknowledged");
		} catch (error) {
			lastError = error;
		}
		await page.waitForTimeout(250);
	}
	throw lastError || new Error("Invoice submission did not resolve");
}

async function findInvoicesByRequestId(
	page: Page,
	doctype: string,
	requestId: string,
) {
	return callFrappe<Array<{ name: string; docstatus: number }>>(
		page,
		"frappe.client.get_list",
		{
			doctype,
			filters: { posa_client_request_id: requestId },
			fields: ["name", "docstatus"],
			limit_page_length: 10,
		},
	);
}

async function cancelInvoicesByRequestId(
	page: Page,
	doctype: string,
	requestId: string,
) {
	const rows = await findInvoicesByRequestId(page, doctype, requestId).catch(
		() => [],
	);
	for (const row of rows) {
		if (Number(row.docstatus) === 1) {
			await callFrappe(page, "frappe.client.cancel", {
				doctype,
				name: row.name,
			}).catch(() => undefined);
		}
	}
}

test("two terminals resolve one canonical invoice without duplicates", async ({
	browser,
	page,
}) => {
	test.setTimeout(5 * 60_000);
	if (!CASHIER_PIN) {
		throw new Error(
			"Multi-terminal idempotency requires POSA_E2E_CASHIER_PIN.",
		);
	}
	await page.setViewportSize({ width: 1280, height: 720 });
	await waitForPos(page);
	await addSingleItem(page);
	await page.getByTestId("invoice-action-pay").click();
	await expect(page.getByTestId("payment-root")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("payment-submit")).toBeEnabled({
		timeout: 15_000,
	});

	const captured = await captureSubmissionPayload(page);
	const capturedRequestId = String(
		captured.invoice?.posa_client_request_id ||
			captured.data?.client_request_id ||
			"",
	);
	if (capturedRequestId) {
		await removeOutboxEntry(page, capturedRequestId);
	}

	const requestId = `e2e-multi-terminal-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	const payload: SubmissionPayload = JSON.parse(JSON.stringify(captured));
	expect(payload.cashier_pin).toBe(CASHIER_PIN);
	expect(payload.invoice).not.toHaveProperty("cashier_pin");
	expect(payload.data).not.toHaveProperty("cashier_pin");
	payload.invoice.posa_client_request_id = requestId;
	payload.data.client_request_id = requestId;
	payload.data.idempotency_key = requestId;

	const storageState = await page.context().storageState();
	const firstContext = await browser.newContext({ storageState });
	const secondContext = await browser.newContext({ storageState });
	let cleanupPage: Page | null = null;
	let authoritativeDoctype = String(
		payload.invoice.doctype || "Sales Invoice",
	);

	try {
		const [firstTerminal, secondTerminal] = await Promise.all([
			openTerminal(firstContext),
			openTerminal(secondContext),
		]);
		cleanupPage = firstTerminal;

		const [firstResult, secondResult] = await Promise.all([
			submitUntilResolved(firstTerminal, requestId, payload),
			submitUntilResolved(secondTerminal, requestId, payload),
		]);

		expect(firstResult.client_request_id).toBe(requestId);
		expect(secondResult.client_request_id).toBe(requestId);
		expect(firstResult.name).toBe(secondResult.name);
		expect(firstResult.docstatus).toBe(1);
		expect(secondResult.docstatus).toBe(1);
		authoritativeDoctype = firstResult.doctype || authoritativeDoctype;

		const invoices = await findInvoicesByRequestId(
			firstTerminal,
			authoritativeDoctype,
			requestId,
		);
		expect(invoices).toEqual([
			expect.objectContaining({
				name: firstResult.name,
				docstatus: 1,
			}),
		]);
	} finally {
		if (cleanupPage) {
			await cancelInvoicesByRequestId(
				cleanupPage,
				authoritativeDoctype,
				requestId,
			);
			if (capturedRequestId) {
				await cancelInvoicesByRequestId(
					cleanupPage,
					authoritativeDoctype,
					capturedRequestId,
				);
			}
		}
		await Promise.all([firstContext.close(), secondContext.close()]);
	}
});
