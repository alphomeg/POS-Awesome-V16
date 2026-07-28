// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { close_payments, show_payment } from "../src/posapp/components/pos/invoice_utils/dialogs";

const createPaymentContext = () => ({
	_suppressClosePaymentsTimer: null,
	_suppressClosePayments: false,
	customer: "CUST-001",
	items: [{ item_code: "ITEM-001" }],
	validate: vi.fn(async () => true),
	ensure_auto_batch_selection: vi.fn(async () => {}),
	invoiceType: "Invoice",
	pos_profile: { currency: "USD" },
	invoice_doc: {},
	process_invoice: vi.fn(async () => ({
		doctype: "Sales Invoice",
		name: "ACC-SINV-DRAFT-001",
		grand_total: 10,
		rounded_total: 10,
		total: 10,
		payments: [],
	})),
	process_invoice_from_order: vi.fn(),
	reload_current_invoice_from_backend: vi.fn(),
	selected_currency: "USD",
	conversion_rate: 1,
	_getPlcConversionRate: () => 1,
	flt: (value: unknown) => Number(value || 0),
	currency_precision: 2,
	float_precision: 2,
	isReturnInvoice: false,
	get_payments: () => [],
	$nextTick: async () => {},
	uiStore: {
		openPaymentDialog: vi.fn(),
		closePaymentDialog: vi.fn(),
		openPaymentShortcutHost: vi.fn(),
		closePaymentShortcutHost: vi.fn(),
		setActiveView: vi.fn(),
	},
	eventBus: { emit: vi.fn() },
	toastStore: { show: vi.fn() },
});

describe("invoice payment dialogs", () => {
	beforeEach(() => {
		vi.stubGlobal("__", (value: string) => value);
		vi.stubGlobal("frappe", { call: vi.fn() });
		Object.defineProperty(window, "innerWidth", {
			value: 500,
			writable: true,
			configurable: true,
		});
	});

	it("switches compact layout to the selector when opening payments", async () => {
		const context = createPaymentContext();

		await show_payment(context);

		expect(context.reload_current_invoice_from_backend).toHaveBeenCalledTimes(1);
		expect(context.uiStore.setActiveView).toHaveBeenCalledWith("payment");
		expect(context.eventBus.emit).toHaveBeenCalledWith("set_compact_panel", "selector");
		expect(context.eventBus.emit).toHaveBeenCalledWith("show_payment", "true");
	});

	it("switches compact layout back to the invoice when closing payments", () => {
		const context = {
			_suppressClosePayments: false,
			paymentVisible: true,
			uiStore: {
				paymentDialogOpen: false,
				closePaymentDialog: vi.fn(),
				setActiveView: vi.fn(),
			},
			eventBus: { emit: vi.fn() },
		};

		close_payments(context);

		expect(context.uiStore.setActiveView).toHaveBeenCalledWith("items");
		expect(context.eventBus.emit).toHaveBeenCalledWith("set_compact_panel", "invoice");
		expect(context.eventBus.emit).toHaveBeenCalledWith("show_payment", "false");
	});

	it("closes the shortcut host without opening the payment view", () => {
		const context = {
			_suppressClosePayments: false,
			paymentVisible: true,
			uiStore: {
				paymentDialogOpen: false,
				paymentShortcutHostOpen: true,
				closePaymentShortcutHost: vi.fn(),
				setActiveView: vi.fn(),
			},
			eventBus: { emit: vi.fn() },
		};

		close_payments(context);

		expect(context.uiStore.closePaymentShortcutHost).toHaveBeenCalledTimes(1);
		expect(context.uiStore.setActiveView).toHaveBeenCalledWith("items");
		expect(context.eventBus.emit).toHaveBeenCalledWith("show_payment", "false");
	});

	it("keeps the payment surface open while checkout is locked", () => {
		const context = {
			_suppressClosePayments: false,
			paymentVisible: true,
			uiStore: {
				checkoutMutationLocked: true,
				paymentDialogOpen: true,
				paymentShortcutHostOpen: true,
				closePaymentDialog: vi.fn(),
				closePaymentShortcutHost: vi.fn(),
				setActiveView: vi.fn(),
			},
			eventBus: { emit: vi.fn() },
		};

		close_payments(context);

		expect(context.uiStore.closePaymentDialog).not.toHaveBeenCalled();
		expect(context.uiStore.closePaymentShortcutHost).not.toHaveBeenCalled();
		expect(context.uiStore.setActiveView).not.toHaveBeenCalled();
		expect(context.eventBus.emit).not.toHaveBeenCalled();
	});

	it("routes shortcut payment preparation to the signing host", async () => {
		Object.defineProperty(window, "innerWidth", {
			value: 1366,
			writable: true,
			configurable: true,
		});
		const context = createPaymentContext();

		await show_payment(context, { shortcutOnly: true });

		expect(context.reload_current_invoice_from_backend).not.toHaveBeenCalled();
		expect(context.uiStore.openPaymentShortcutHost).toHaveBeenCalledTimes(1);
		expect(context.uiStore.openPaymentDialog).not.toHaveBeenCalled();
		expect(context.uiStore.setActiveView).not.toHaveBeenCalledWith("payment");
	});

	it("does not reopen an already-mounted shortcut host", async () => {
		const context = createPaymentContext();

		await show_payment(context, {
			shortcutOnly: true,
			hostAlreadyOpen: true,
		});

		expect(context.uiStore.openPaymentShortcutHost).not.toHaveBeenCalled();
		expect(context.eventBus.emit).toHaveBeenCalledWith(
			"send_invoice_doc_payment",
			expect.objectContaining({ name: "ACC-SINV-DRAFT-001" }),
		);
	});

	it("does not publish prepared payment state after shortcut cancellation", async () => {
		const context = createPaymentContext();
		const controller = new AbortController();
		context.validate = vi.fn(async () => {
			controller.abort();
			return true;
		});

		await expect(
			show_payment(context, {
				shortcutOnly: true,
				hostAlreadyOpen: true,
				signal: controller.signal,
			}),
		).resolves.toBeNull();

		expect(context.process_invoice).not.toHaveBeenCalled();
		expect(context.eventBus.emit).not.toHaveBeenCalledWith(
			"show_payment",
			"true",
		);
	});
});
