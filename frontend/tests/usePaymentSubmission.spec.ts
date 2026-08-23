// @vitest-environment jsdom

import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePaymentSubmission } from "../src/posapp/composables/pos/payments/usePaymentSubmission";
import { isOffline } from "../src/offline/index";
import {
	buildInvoiceRecoveryCartFingerprint,
	claimInvoiceRecoveryClientEffects,
	getActiveInvoiceSubmissionRecovery,
	hasInvoiceRecoveryClientEffects,
	persistActiveInvoiceSubmissionRecovery,
	resetInvoiceRecoveryMemoryForTests,
	resetInvoiceRecoveryStateForTests,
} from "../src/posapp/composables/pos/payments/recoveryState";
import { ApiEnvelopeError } from "../src/posapp/services/api";

vi.mock("../src/offline/index", () => ({
	enqueueInvoiceOutboxEntry: vi.fn(async () => ({})),
	consumeOfflineCashSaleAuthorization: vi.fn(async () => true),
	finalizeAcknowledgedInvoiceOutboxEntry: vi.fn(async () => ({
		status: "acknowledged",
	})),
	getOfflineCustomers: vi.fn(() => []),
	getInvoiceOutboxRows: vi.fn(async () => []),
	isOffline: vi.fn(() => false),
	persistInvoiceIntentJournal: vi.fn(() => "test-request-id"),
	removeInvoiceIntentJournal: vi.fn(),
	removeInvoiceIntentJournalStrict: vi.fn(),
	removeInvoiceOutboxEntry: vi.fn(async () => 1),
	releaseOfflineCashSaleAuthorization: vi.fn(async () => true),
	saveOfflineInvoice: vi.fn(),
	updateLocalStock: vi.fn(),
	validateStockForOfflineInvoice: vi.fn(() => ({ isValid: true })),
}));

vi.mock("../src/posapp/services/invoiceService", () => ({
	default: {
		submitInvoice: vi.fn(),
	},
}));

vi.mock("../src/posapp/utils/stockCoordinator", () => ({
	default: {
		applyInvoiceConsumption: vi.fn(),
	},
}));

const mockInvoiceSubmissionResponse = (
	invoiceService: any,
	response: Record<string, any>,
	options: { once?: boolean } = {},
) => {
	const implementation = async (_data: any, submittedDoc: any) => ({
		...response,
		client_request_id: submittedDoc.posa_client_request_id,
	});
	const submitMock = invoiceService.submitInvoice as any;
	if (options.once) {
		submitMock.mockImplementationOnce(implementation);
	} else {
		submitMock.mockImplementation(implementation);
	}
};

const persistScopedRecovery = (
	recovery: Parameters<typeof persistActiveInvoiceSubmissionRecovery>[0],
) =>
	persistActiveInvoiceSubmissionRecovery({
		posProfile: "Main POS",
		company: "Test Company",
		user: "cashier@example.test",
		documentType: "Sales Invoice",
		recoveryMode: "invoice_outbox",
		...recovery,
	});

describe("usePaymentSubmission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Individual regression cases toggle reachability. Reset it here so an
		// expected offline rejection cannot leak into the following online case.
		vi.mocked(isOffline).mockReturnValue(false);
		resetInvoiceRecoveryStateForTests();
		vi.stubGlobal("__", (value: string, args?: any[]) => {
			if (!args?.length) return value;
			return value.replace(/\{(\d+)\}/g, (_match, index) =>
				String(args[Number(index)] ?? ""),
			);
		});
		vi.stubGlobal("frappe", {
			session: { user: "cashier@example.test" },
			utils: {
				play_sound: vi.fn(),
			},
		});
	});

	it("restores negative return payments back to normal amounts", () => {
		const invoiceDoc = ref<any>({
			is_return: 0,
			payments: [
				{
					mode_of_payment: "Cash",
					amount: -120,
					base_amount: -120,
					default: 1,
				},
				{ mode_of_payment: "Card", amount: 0, base_amount: 0 },
				{ mode_of_payment: "Bank", amount: 35, base_amount: 35 },
			],
		});

		const { restoreReturnPayments } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			isCashback: ref(true),
		});

		restoreReturnPayments();

		expect(invoiceDoc.value.payments).toEqual([
			{
				mode_of_payment: "Cash",
				amount: 120,
				base_amount: 120,
				default: 1,
			},
			{ mode_of_payment: "Card", amount: 0, base_amount: 0 },
			{ mode_of_payment: "Bank", amount: 35, base_amount: 35 },
		]);
	});

	it("blocks submission validation when a sale row is below trade price", async () => {
		const invoiceDoc = ref<any>({
			is_return: 0,
			items: [
				{
					item_code: "02017",
					item_name: "ARINAC FORT",
					qty: 1,
					rate: 10,
					trade_price: 12.75,
				},
			],
			payments: [{ mode_of_payment: "Cash", amount: 10, type: "Cash" }],
			rounded_total: 10,
			grand_total: 10,
		});

		const { validateSubmission } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({ posa_allow_partial_payment: 0 }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
			},
			diff_payment: ref(0) as any,
			isCashback: ref(true),
		});

		await expect(validateSubmission(true)).rejects.toThrow(
			/below Trade Price/i,
		);
	});

	it("defers print and schedules background wait when invoice submission is queued", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0001",
			doctype: "Sales Invoice",
			status: 0,
			queued: true,
			acknowledged: true,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0001",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [],
			payments: [{ mode_of_payment: "Cash", amount: 690, type: "Cash" }],
			rounded_total: 690,
			grand_total: 690,
		});
		const onPrint = vi.fn();
		const onScheduleBackgroundCheck = vi.fn();

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 1,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(true),
			paidChange: ref(10),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(100),
			customerCreditDict: ref([]),
			diff_payment: ref(-10),
		});

		await submitInvoice(true, {
			onPrint,
			onScheduleBackgroundCheck,
			onFinishNavigation: vi.fn(),
		});

		expect(onPrint).not.toHaveBeenCalled();
		expect(onScheduleBackgroundCheck).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "ACC-SINV-0001",
				doctype: "Sales Invoice",
				print: true,
				waitForInvoiceProcessing: true,
				waitForPostSubmitPayments: true,
			}),
		);
		expect(offlineModule.removeInvoiceOutboxEntry).not.toHaveBeenCalled();
	});

	it("schedules deferred printing instead of calling onPrint when post-submit work remains", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0002",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0002",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [],
			payments: [{ mode_of_payment: "Cash", amount: 690, type: "Cash" }],
			rounded_total: 690,
			grand_total: 690,
		});
		const onPrint = vi.fn();
		const onScheduleBackgroundCheck = vi.fn();

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 1,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(true),
			paidChange: ref(10),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(100),
			customerCreditDict: ref([]),
			diff_payment: ref(-10),
		});

		await submitInvoice(true, {
			onPrint,
			onFinishNavigation: vi.fn(),
			onScheduleBackgroundCheck,
		});

		expect(onPrint).not.toHaveBeenCalled();
		expect(onScheduleBackgroundCheck).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "ACC-SINV-0002",
				doctype: "Sales Invoice",
				waitForInvoiceProcessing: false,
				waitForPostSubmitPayments: true,
			}),
		);
	});

	it("prints immediately when there is no deferred post-submit work", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0004",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0004",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [],
			payments: [{ mode_of_payment: "Cash", amount: 690, type: "Cash" }],
			rounded_total: 690,
			grand_total: 690,
		});
		const onPrint = vi.fn();
		const onScheduleBackgroundCheck = vi.fn();

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 1,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(true),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await submitInvoice(true, {
			onPrint,
			onFinishNavigation: vi.fn(),
			onScheduleBackgroundCheck,
		});

		expect(onPrint).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "ACC-SINV-0004",
				doctype: "Sales Invoice",
				docstatus: 1,
			}),
			expect.objectContaining({
				name: "ACC-SINV-0004",
				doctype: "Sales Invoice",
				waitForInvoiceProcessing: false,
				waitForPostSubmitPayments: false,
			}),
		);
		expect(onScheduleBackgroundCheck).not.toHaveBeenCalled();
	});

	it("prints a newly submitted Sales Order with the server-assigned name", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		(invoiceService.submitInvoice as any).mockResolvedValue({
			name: "SAL-ORD-0001",
			doctype: "Sales Order",
			status: 1,
		});

		const invoiceDoc = ref<any>({
			doctype: "Sales Order",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 100, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			posa_delivery_date: "2026-07-01",
		});
		const onPrint = vi.fn();
		const setLastInvoice = vi.fn();
		const mergeInvoiceDoc = vi.fn((patch) => {
			Object.assign(invoiceDoc.value, patch);
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				posa_allow_sales_order: 1,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Order"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice,
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value, mergeInvoiceDoc },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await submitInvoice(true, {
			onPrint,
			onFinishNavigation: vi.fn(),
			onScheduleBackgroundCheck: vi.fn(),
		});

		expect(onPrint).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "SAL-ORD-0001",
				doctype: "Sales Order",
				docstatus: 1,
			}),
			expect.objectContaining({
				name: "SAL-ORD-0001",
				doctype: "Sales Order",
				waitForInvoiceProcessing: false,
				waitForPostSubmitPayments: false,
			}),
		);
		expect(mergeInvoiceDoc).toHaveBeenCalledWith({
			name: "SAL-ORD-0001",
			doctype: "Sales Order",
			docstatus: 1,
		});
		expect(invoiceDoc.value.name).toBe("SAL-ORD-0001");
		expect(setLastInvoice).toHaveBeenCalledWith("SAL-ORD-0001");
		expect(
			offlineModule.persistInvoiceIntentJournal,
		).not.toHaveBeenCalled();
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
	});

	it("shows a merged processing toast instead of a plain success toast when post-submit payments are pending", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0003",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0003",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [],
			payments: [{ mode_of_payment: "Cash", amount: 690, type: "Cash" }],
			rounded_total: 690,
			grand_total: 690,
		});
		const toastShow = vi.fn();

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 1,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: toastShow },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(true),
			paidChange: ref(10),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(100),
			customerCreditDict: ref([]),
			diff_payment: ref(-10),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
			onScheduleBackgroundCheck: vi.fn(),
		});

		expect(toastShow).toHaveBeenCalledWith(
			expect.objectContaining({
				key: "invoice-processing::ACC-SINV-0003",
				title: "Invoice Submitted",
				loading: true,
			}),
		);
	});

	it("includes gift card redemptions in the submit payload", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0005",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0005",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [],
			payments: [{ mode_of_payment: "Cash", amount: 390, type: "Cash" }],
			rounded_total: 690,
			grand_total: 690,
		});

		const giftCardRedemptions = ref([
			{
				gift_card_code: "GC-0001",
				amount: 300,
				cashier: "cashier@example.com",
			},
		]);

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 1,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			giftCardRedemptions,
			diff_payment: ref(390),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
			onScheduleBackgroundCheck: vi.fn(),
		});

		expect(invoiceService.submitInvoice).toHaveBeenCalledWith(
			expect.objectContaining({
				gift_card_redemptions: [
					expect.objectContaining({
						gift_card_code: "GC-0001",
						amount: 300,
					}),
				],
			}),
			expect.objectContaining({
				payments: [
					expect.objectContaining({
						mode_of_payment: "Cash",
						amount: 390,
					}),
				],
			}),
			"Invoice",
			expect.any(Object),
		);
	});

	it("adds a stable client request id to invoice submissions", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0099",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0099",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 50, type: "Cash" }],
			rounded_total: 50,
			grand_total: 50,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc.posa_client_request_id).toEqual(expect.any(String));
		expect(invoiceDoc.value.posa_client_request_id).toBe(
			submittedDoc.posa_client_request_id,
		);
	});

	it("computes base write-off amount with the invoice conversion rate", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-MC-WRITEOFF",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-MC-WRITEOFF",
			doctype: "Sales Invoice",
			currency: "USD",
			conversion_rate: 280,
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 90, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				currency: "PKR",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(10),
			is_write_off_change: ref(true),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc.write_off_amount).toBe(10);
		expect(submittedDoc.base_write_off_amount).toBe(2800);
	});

	it("locks an ambiguous timeout behind one durable request and urgent reconciliation", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		(invoiceService.submitInvoice as any).mockRejectedValueOnce(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "TIMEOUT",
					message: "Request timed out",
					retryable: true,
				},
				requestId: "transport-timeout-001",
				serverTime: null,
			}),
		);
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const toastStore = { show: vi.fn() };
		const syncStore = { syncPendingInvoices: vi.fn(async () => undefined) };

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0100",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 50, type: "Cash" }],
			rounded_total: 50,
			grand_total: 50,
		});

		const {
			submitInvoice,
			submissionRecovery,
			submissionRecoveryLocked,
			stopSubmissionRecoveryMonitor,
		} = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore,
				syncStore,
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		const firstResult = await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});
		const secondResult = await submitInvoice(true, {
			onFinishNavigation: vi.fn(),
		});

		const firstData = (invoiceService.submitInvoice as any).mock
			.calls[0][0];
		const firstSubmittedDoc = (invoiceService.submitInvoice as any).mock
			.calls[0][1];

		expect(firstSubmittedDoc.posa_client_request_id).toEqual(
			expect.any(String),
		);
		expect(invoiceDoc.value.posa_client_request_id).toBe(
			firstSubmittedDoc.posa_client_request_id,
		);
		expect(firstData).toEqual(
			expect.objectContaining({
				idempotency_key: firstSubmittedDoc.posa_client_request_id,
				client_request_id: firstSubmittedDoc.posa_client_request_id,
			}),
		);
		expect(firstResult).toEqual({
			confirmationPending: true,
			requestId: firstSubmittedDoc.posa_client_request_id,
		});
		expect(secondResult).toEqual(firstResult);
		expect(invoiceService.submitInvoice).toHaveBeenCalledTimes(1);
		expect(offlineModule.enqueueInvoiceOutboxEntry).toHaveBeenCalledTimes(
			2,
		);
		for (const [entry] of (offlineModule.enqueueInvoiceOutboxEntry as any)
			.mock.calls) {
			expect(entry.invoice.posa_client_request_id).toBe(
				firstSubmittedDoc.posa_client_request_id,
			);
		}
		expect(offlineModule.removeInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(submissionRecoveryLocked.value).toBe(true);
		expect(submissionRecovery.value).toEqual(
			expect.objectContaining({
				phase: "confirming",
				requestId: firstSubmittedDoc.posa_client_request_id,
			}),
		);
		expect(toastStore.show).toHaveBeenCalledTimes(1);
		expect(toastStore.show).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Sale received; confirming status — do not retry",
				color: "warning",
				timeout: -1,
				loading: true,
			}),
		);
		await vi.waitFor(() => {
			expect(syncStore.syncPendingInvoices).toHaveBeenCalledTimes(1);
		});
		stopSubmissionRecoveryMonitor();
		consoleWarn.mockRestore();
	});

	it.each([
		[400, "Bad Request"],
		[409, "Conflict"],
	])(
		"keeps an unstructured HTTP %s direct submission in durable recovery",
		async (status, message) => {
			const invoiceService = (
				await import("../src/posapp/services/invoiceService")
			).default;
			const offlineModule = await import("../src/offline/index");
			(invoiceService.submitInvoice as any).mockRejectedValueOnce(
				new ApiEnvelopeError({
					ok: false,
					data: null,
					error: {
						code: "HTTP_ERROR",
						message,
						retryable: false,
					},
					requestId: `http-${status}-submission-001`,
					serverTime: null,
				}),
			);
			const consoleWarn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const syncStore = {
				syncPendingInvoices: vi.fn(async () => undefined),
			};
			const invoiceDoc = ref<any>({
				name: `LOCAL-HTTP-${status}-SUBMISSION`,
				doctype: "Sales Invoice",
				pos_profile: "Main POS",
				company: "Test Company",
				is_return: 0,
				items: [{ item_code: `ITEM-HTTP-${status}`, qty: 1 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 25, type: "Cash" },
				],
				rounded_total: 25,
				grand_total: 25,
			});
			const submission = usePaymentSubmission({
				invoiceDoc,
				posProfile: ref({
					name: "Main POS",
					company: "Test Company",
					posa_allow_submissions_in_background_job: 0,
					create_pos_invoice_instead_of_sales_invoice: 0,
				}),
				stockSettings: ref({}),
				invoiceType: ref("Invoice"),
				formatFloat: (value) => Number(value || 0),
				stores: {
					toastStore: { show: vi.fn() },
					syncStore,
					uiStore: {
						setLastInvoice: vi.fn(),
						setLastStockAdjustment: vi.fn(),
					},
					invoiceStore: { invoiceDoc: invoiceDoc.value },
				},
			});

			try {
				const firstResult = await submission.submitInvoice(false);
				const secondResult = await submission.submitInvoice(true);
				const requestId = invoiceDoc.value.posa_client_request_id;

				expect(firstResult).toEqual({
					confirmationPending: true,
					requestId,
				});
				expect(secondResult).toEqual(firstResult);
				expect(invoiceService.submitInvoice).toHaveBeenCalledTimes(1);
				expect(
					offlineModule.persistInvoiceIntentJournal,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						invoice: expect.objectContaining({
							posa_client_request_id: requestId,
						}),
					}),
				);
				await vi.waitFor(() => {
					expect(
						offlineModule.enqueueInvoiceOutboxEntry,
					).toHaveBeenCalled();
				});
				expect(
					offlineModule.removeInvoiceOutboxEntry,
				).not.toHaveBeenCalled();
				expect(
					offlineModule.removeInvoiceIntentJournalStrict,
				).not.toHaveBeenCalled();
				expect(submission.submissionRecoveryLocked.value).toBe(true);
				expect(submission.submissionRecovery.value).toEqual(
					expect.objectContaining({
						phase: "confirming",
						requestId,
					}),
				);
				expect(getActiveInvoiceSubmissionRecovery()).toEqual(
					expect.objectContaining({
						requestId,
						recoveryMode: "invoice_outbox",
					}),
				);
			} finally {
				submission.stopSubmissionRecoveryMonitor();
				consoleWarn.mockRestore();
			}
		},
	);

	it.each([
		["empty", {}],
		["name-only", { name: "ACC-SINV-UNPROVEN" }],
		["acknowledgement-only", { acknowledged: true }],
		["status-only", { docstatus: 1, doctype: "Sales Invoice" }],
		[
			"missing-request-identity",
			{
				name: "ACC-SINV-MISSING-REQUEST",
				docstatus: 1,
				doctype: "Sales Invoice",
			},
		],
		[
			"wrong-doctype",
			{
				name: "ACC-SINV-WRONG-TYPE",
				docstatus: 1,
				doctype: "Sales Order",
			},
		],
		[
			"mismatched-request",
			{
				name: "ACC-SINV-WRONG-REQUEST",
				docstatus: 1,
				doctype: "Sales Invoice",
				client_request_id: "different-request-id",
			},
		],
	])(
		"reconciles a syntactically valid but %s unproven response",
		async (_label, response) => {
			const invoiceService = (
				await import("../src/posapp/services/invoiceService")
			).default;
			const offlineModule = await import("../src/offline/index");
			(invoiceService.submitInvoice as any).mockResolvedValueOnce(
				response,
			);
			(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([]);
			const consoleWarn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const toastStore = { show: vi.fn() };
			const syncStore = {
				syncPendingInvoices: vi.fn(async () => undefined),
			};
			const callbacks = {
				onPrint: vi.fn(),
				onFinishNavigation: vi.fn(),
				onSuccess: vi.fn(),
			};
			const submission = usePaymentSubmission({
				invoiceDoc: ref({
					name: "LOCAL-UNPROVEN-RESPONSE",
					doctype: "Sales Invoice",
					is_return: 0,
					items: [{ item_code: "ITEM-UNPROVEN", qty: 1 }],
					payments: [
						{
							mode_of_payment: "Cash",
							amount: 10,
							type: "Cash",
						},
					],
					rounded_total: 10,
					grand_total: 10,
				}),
				posProfile: ref({
					name: "Main POS",
					company: "Test Company",
				}),
				stockSettings: ref({}),
				invoiceType: ref("Invoice"),
				formatFloat: (value) => Number(value || 0),
				stores: { toastStore, syncStore },
			});

			try {
				const result = await submission.submitInvoice(true, callbacks);

				expect(result).toEqual(
					expect.objectContaining({ confirmationPending: true }),
				);
				expect(submission.submissionRecoveryLocked.value).toBe(true);
				expect(submission.submissionRecovery.value.phase).toBe(
					"confirming",
				);
				expect(callbacks.onPrint).not.toHaveBeenCalled();
				expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
				expect(callbacks.onSuccess).not.toHaveBeenCalled();
				expect(
					offlineModule.removeInvoiceOutboxEntry,
				).not.toHaveBeenCalled();
				expect(getActiveInvoiceSubmissionRecovery()).toEqual(
					expect.objectContaining({
						recoveryMode: "invoice_outbox",
					}),
				);
			} finally {
				submission.stopSubmissionRecoveryMonitor();
				consoleWarn.mockRestore();
			}
		},
	);

	it.each([
		["Order", "Sales Order"],
		["Quotation", "Quotation"],
	])(
		"keeps an ambiguous %s in durable manual review without invoice replay",
		async (invoiceTypeValue, documentType) => {
			const invoiceService = (
				await import("../src/posapp/services/invoiceService")
			).default;
			const offlineModule = await import("../src/offline/index");
			(invoiceService.submitInvoice as any).mockRejectedValueOnce(
				new ApiEnvelopeError({
					ok: false,
					data: null,
					error: {
						code: "TIMEOUT",
						message: "Request timed out",
						retryable: true,
					},
					requestId: `transport-${invoiceTypeValue}`,
					serverTime: null,
				}),
			);
			const consoleWarn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			(globalThis as any).frappe.call = vi.fn();
			const syncStore = {
				syncPendingInvoices: vi.fn(async () => undefined),
			};
			const firstSubmission = usePaymentSubmission({
				invoiceDoc: ref({
					name: `LOCAL-${invoiceTypeValue.toUpperCase()}`,
					doctype: documentType,
					is_return: 0,
					items: [{ item_code: "ITEM-MANUAL", qty: 1 }],
					payments: [
						{
							mode_of_payment: "Cash",
							amount: 12,
							type: "Cash",
						},
					],
					rounded_total: 12,
					grand_total: 12,
				}),
				posProfile: ref({
					name: "Main POS",
					company: "Test Company",
					posa_allow_sales_order: 1,
				}),
				stockSettings: ref({}),
				invoiceType: ref(invoiceTypeValue),
				formatFloat: (value) => Number(value || 0),
				stores: {
					toastStore: { show: vi.fn() },
					syncStore,
				},
			});

			try {
				const result = await firstSubmission.submitInvoice(false);

				expect(result).toEqual(
					expect.objectContaining({
						confirmationPending: true,
						manualReview: true,
						automaticRecoveryAvailable: false,
					}),
				);
				expect(firstSubmission.submissionRecovery.value.phase).toBe(
					"manual_review",
				);
				expect(
					offlineModule.persistInvoiceIntentJournal,
				).not.toHaveBeenCalled();
				expect(
					offlineModule.enqueueInvoiceOutboxEntry,
				).not.toHaveBeenCalled();
				expect(syncStore.syncPendingInvoices).not.toHaveBeenCalled();
				expect(getActiveInvoiceSubmissionRecovery()).toEqual(
					expect.objectContaining({
						documentType,
						recoveryMode: "manual_only",
					}),
				);

				resetInvoiceRecoveryMemoryForTests();
				const remountedSubmission = usePaymentSubmission({
					invoiceDoc: ref({}),
					posProfile: ref({
						name: "Main POS",
						company: "Test Company",
					}),
					stockSettings: ref({}),
					invoiceType: ref(invoiceTypeValue),
					formatFloat: (value) => Number(value || 0),
					stores: { toastStore: { show: vi.fn() } },
				});
				const resumeResult =
					await remountedSubmission.resumePendingSubmissionRecovery();
				expect(resumeResult).toEqual(
					expect.objectContaining({
						phase: "manual_review",
						automaticRecoveryAvailable: false,
					}),
				);
				expect(
					offlineModule.getInvoiceOutboxRows,
				).not.toHaveBeenCalled();
				await expect(
					remountedSubmission.manuallyReconcilePendingSubmission(),
				).resolves.toEqual(
					expect.objectContaining({
						confirmed: false,
						automaticRecoveryAvailable: false,
					}),
				);
				expect((globalThis as any).frappe.call).not.toHaveBeenCalled();
			} finally {
				consoleWarn.mockRestore();
			}
		},
	);

	it("audits a supervisor-confirmed Sales Order and clears its cart exactly once without invoice replay", async () => {
		const offlineModule = await import("../src/offline/index");
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		persistScopedRecovery({
			requestId: "manual-order-submitted-001",
			invoiceName: "LOCAL-SALES-ORDER",
			documentType: "Sales Order",
			recoveryMode: "manual_only",
			printRequested: false,
		});
		const invoiceDoc = ref<any>({
			name: "LOCAL-SALES-ORDER",
			doctype: "Sales Order",
			company: "Test Company",
			pos_profile: "Main POS",
			posa_client_request_id: "manual-order-submitted-001",
			items: [{ item_code: "ITEM-1", qty: 1 }],
		});
		const invoiceStore = {
			mergeInvoiceDoc: vi.fn(),
			clear: vi.fn(),
			resetPostingDate: vi.fn(),
		};
		const onFinishNavigation = vi.fn();
		(globalThis as any).frappe.call = vi.fn().mockResolvedValue({
			message: {
				resolved: true,
				client_request_id: "manual-order-submitted-001",
				document_type: "Sales Order",
				document_name: "SAL-ORD-0001",
				outcome: "submitted",
				audit_name: "COMMENT-0001",
			},
		});
		const submission = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				posa_allow_sales_order: 1,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Order"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				invoiceStore,
			},
		});

		await submission.resumePendingSubmissionRecovery({
			onFinishNavigation,
		});
		expect(submission.submissionRecoveryCanResolveManually.value).toBe(
			true,
		);
		const result = await submission.resolveManualOnlySubmissionRecovery({
			outcome: "submitted",
			documentName: "SAL-ORD-0001",
			note: "Verified submitted in the Sales Order list",
			confirmation: "manual-order-submitted-001",
		});

		expect(result).toEqual(
			expect.objectContaining({
				resolved: true,
				outcome: "submitted",
				auditName: "COMMENT-0001",
			}),
		);
		expect((globalThis as any).frappe.call).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "posawesome.posawesome.api.manual_submission_recovery.resolve_manual_submission_recovery",
			}),
		);
		expect(invoiceStore.mergeInvoiceDoc).toHaveBeenCalledWith({
			name: "SAL-ORD-0001",
			doctype: "Sales Order",
			docstatus: 1,
		});
		expect(invoiceStore.clear).toHaveBeenCalledTimes(1);
		expect(invoiceStore.resetPostingDate).toHaveBeenCalledTimes(1);
		expect(onFinishNavigation).toHaveBeenCalledTimes(1);
		expect(onFinishNavigation).toHaveBeenCalledWith(true);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(submission.submissionRecovery.value.phase).toBe("confirmed");
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(invoiceService.submitInvoice).not.toHaveBeenCalled();
	});

	it("audits a not-created Quotation, retains its cart, and rotates the retry identity", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		persistScopedRecovery({
			requestId: "manual-quotation-not-created-001",
			invoiceName: "LOCAL-QUOTATION",
			documentType: "Quotation",
			recoveryMode: "manual_only",
			printRequested: false,
		});
		const items = [{ item_code: "ITEM-Q", qty: 2 }];
		const invoiceDoc = ref<any>({
			name: "LOCAL-QUOTATION",
			doctype: "Quotation",
			company: "Test Company",
			pos_profile: "Main POS",
			posa_client_request_id: "manual-quotation-not-created-001",
			items,
		});
		const invoiceStore = {
			clear: vi.fn(),
			resetPostingDate: vi.fn(),
		};
		const onFinishNavigation = vi.fn();
		(globalThis as any).frappe.call = vi.fn().mockResolvedValue({
			message: {
				resolved: true,
				client_request_id: "manual-quotation-not-created-001",
				document_type: "Quotation",
				document_name: "LOCAL-QUOTATION",
				outcome: "not_submitted",
				audit_name: "COMMENT-0002",
			},
		});
		const submission = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Quotation"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				invoiceStore,
			},
		});

		await submission.resumePendingSubmissionRecovery({
			onFinishNavigation,
		});
		const result = await submission.resolveManualOnlySubmissionRecovery({
			outcome: "not_submitted",
			documentName: "LOCAL-QUOTATION",
			note: "No matching Quotation exists in the back office",
			confirmation: "manual-quotation-not-created-001",
		});

		expect(result).toEqual(
			expect.objectContaining({
				resolved: true,
				outcome: "not_submitted",
				cartRetained: true,
				nextRequestId: expect.stringMatching(/^inv-/),
			}),
		);
		expect(invoiceDoc.value.items).toEqual(items);
		expect(invoiceDoc.value.posa_client_request_id).not.toBe(
			"manual-quotation-not-created-001",
		);
		expect(invoiceStore.clear).not.toHaveBeenCalled();
		expect(invoiceStore.resetPostingDate).not.toHaveBeenCalled();
		expect(onFinishNavigation).not.toHaveBeenCalled();
		expect(invoiceService.submitInvoice).not.toHaveBeenCalled();
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(submission.submissionRecovery.value.phase).toBe("idle");
	});

	it("keeps a manual-only sale locked when its supervisor audit fails", async () => {
		persistScopedRecovery({
			requestId: "manual-audit-failure-001",
			invoiceName: "LOCAL-SALES-ORDER",
			documentType: "Sales Order",
			recoveryMode: "manual_only",
			printRequested: false,
		});
		(globalThis as any).frappe.call = vi
			.fn()
			.mockRejectedValue(new Error("Audit service unavailable"));
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-SALES-ORDER",
				doctype: "Sales Order",
				company: "Test Company",
				pos_profile: "Main POS",
				posa_client_request_id: "manual-audit-failure-001",
			}),
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				posa_allow_sales_order: 1,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Order"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore: { show: vi.fn() } },
		});

		await submission.resumePendingSubmissionRecovery();
		const result = await submission.resolveManualOnlySubmissionRecovery({
			outcome: "not_submitted",
			documentName: "LOCAL-SALES-ORDER",
			note: "Back-office check completed",
			confirmation: "manual-audit-failure-001",
		});

		expect(result).toEqual(
			expect.objectContaining({ resolved: false, manualReview: true }),
		);
		expect(submission.submissionRecovery.value.phase).toBe("manual_review");
		expect(submission.submissionRecoveryLocked.value).toBe(true);
		expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
			"manual-audit-failure-001",
		);
	});

	it("keeps a supervisor-audited manual outcome locked when local pointer cleanup fails", async () => {
		persistScopedRecovery({
			requestId: "manual-cleanup-failure-001",
			invoiceName: "LOCAL-QUOTATION-CLEANUP",
			documentType: "Quotation",
			recoveryMode: "manual_only",
			printRequested: false,
		});
		const invoiceDoc = ref<any>({
			name: "LOCAL-QUOTATION-CLEANUP",
			doctype: "Quotation",
			company: "Test Company",
			pos_profile: "Main POS",
			posa_client_request_id: "manual-cleanup-failure-001",
			items: [{ item_code: "ITEM-LOCKED", qty: 1 }],
		});
		(globalThis as any).frappe.call = vi.fn().mockResolvedValue({
			message: {
				resolved: true,
				client_request_id: "manual-cleanup-failure-001",
				document_type: "Quotation",
				document_name: "LOCAL-QUOTATION-CLEANUP",
				outcome: "not_submitted",
				audit_name: "COMMENT-CLEANUP-FAIL",
			},
		});
		const removeItem = Storage.prototype.removeItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "removeItem")
			.mockImplementation(function (key) {
				if (key === "posa_active_invoice_submission_recovery_v1") {
					return;
				}
				return removeItem.call(this, key);
			});
		const submission = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Quotation"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore: { show: vi.fn() } },
		});

		try {
			await submission.resumePendingSubmissionRecovery();
			const result = await submission.resolveManualOnlySubmissionRecovery(
				{
					outcome: "not_submitted",
					documentName: "LOCAL-QUOTATION-CLEANUP",
					note: "Verified absent, but browser storage is blocked",
					confirmation: "manual-cleanup-failure-001",
				},
			);

			expect(result).toEqual(
				expect.objectContaining({
					resolved: false,
					manualReview: true,
					auditAcknowledged: true,
				}),
			);
			expect(submission.submissionRecovery.value.phase).toBe(
				"manual_review",
			);
			expect(submission.submissionRecoveryLocked.value).toBe(true);
			expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
				"manual-cleanup-failure-001",
			);
			expect(invoiceDoc.value.items).toEqual([
				{ item_code: "ITEM-LOCKED", qty: 1 },
			]);
			expect(invoiceDoc.value.posa_client_request_id).toBe(
				"manual-cleanup-failure-001",
			);
		} finally {
			storageSpy.mockRestore();
		}
	});

	it("hydrates the recovery lock synchronously before any outbox read", async () => {
		const offlineModule = await import("../src/offline/index");
		persistScopedRecovery({
			requestId: "scope-hydration-001",
			invoiceName: "LOCAL-SCOPE-HYDRATION",
			documentType: "Sales Invoice",
			recoveryMode: "invoice_outbox",
			printRequested: false,
		});
		let releaseOutboxRead: (rows: any[]) => void = () => undefined;
		(offlineModule.getInvoiceOutboxRows as any).mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseOutboxRead = resolve;
				}),
		);
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				pos_profile: "Main POS",
				company: "Test Company",
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore: { show: vi.fn() } },
		});

		expect(submission.submissionRecoveryLocked.value).toBe(true);
		expect(submission.submissionRecovery.value).toEqual(
			expect.objectContaining({
				phase: "confirming",
				requestId: "scope-hydration-001",
			}),
		);
		const resumePromise = submission.resumePendingSubmissionRecovery();
		expect(submission.submissionRecoveryLocked.value).toBe(true);
		releaseOutboxRead([]);
		await resumePromise;
	});

	it("blocks a recovery owned by another POS scope before reading or syncing it", async () => {
		const offlineModule = await import("../src/offline/index");
		persistScopedRecovery({
			requestId: "scope-mismatch-001",
			invoiceName: "LOCAL-OTHER-POS",
			documentType: "Sales Invoice",
			recoveryMode: "invoice_outbox",
			printRequested: false,
		});
		const syncStore = { syncPendingInvoices: vi.fn() };
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				pos_profile: "Other POS",
				company: "Other Company",
			}),
			posProfile: ref({ name: "Other POS", company: "Other Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				syncStore,
			},
		});

		const result =
			await submission.resumePendingSubmissionRecovery(callbacks);

		expect(result).toEqual(
			expect.objectContaining({
				manualReview: true,
				scopeBlocked: true,
			}),
		);
		expect(submission.submissionRecovery.value.phase).toBe("manual_review");
		expect(submission.submissionRecoveryLocked.value).toBe(true);
		expect(submission.submissionRecoveryCanCheckStatus.value).toBe(false);
		expect(submission.submissionRecoveryCanResolveManually.value).toBe(
			false,
		);
		expect(offlineModule.getInvoiceOutboxRows).not.toHaveBeenCalled();
		expect(syncStore.syncPendingInvoices).not.toHaveBeenCalled();
		expect(callbacks.onPrint).not.toHaveBeenCalled();
		expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
		expect(callbacks.onSuccess).not.toHaveBeenCalled();
		expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
			"scope-mismatch-001",
		);
	});

	it("persists recovery before dispatch without showing confirmation UX and clears it on direct success", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		const toastStore = { show: vi.fn() };
		(
			offlineModule.finalizeAcknowledgedInvoiceOutboxEntry as any
		).mockImplementationOnce(async () => {
			expect(getActiveInvoiceSubmissionRecovery()).toEqual(
				expect.objectContaining({
					invoiceName: "LOCAL-PRE-DISPATCH-SUCCESS",
				}),
			);
			return { status: "acknowledged" };
		});
		(invoiceService.submitInvoice as any).mockImplementationOnce(
			async (_data: any, submittedDoc: any) => {
				expect(getActiveInvoiceSubmissionRecovery()).toEqual(
					expect.objectContaining({
						requestId: submittedDoc.posa_client_request_id,
						invoiceName: "LOCAL-PRE-DISPATCH-SUCCESS",
						posProfile: "Main POS",
						company: "Test Company",
						user: "cashier@example.test",
						printRequested: true,
					}),
				);
				expect(toastStore.show).not.toHaveBeenCalled();
				return {
					name: "ACC-SINV-PRE-DISPATCH-SUCCESS",
					doctype: "Sales Invoice",
					docstatus: 1,
					client_request_id: submittedDoc.posa_client_request_id,
				};
			},
		);
		const invoiceDoc = ref<any>({
			name: "LOCAL-PRE-DISPATCH-SUCCESS",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-PRE-DISPATCH", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 25, type: "Cash" }],
			rounded_total: 25,
			grand_total: 25,
		});
		const submission = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				posa_allow_submissions_in_background_job: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore,
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				invoiceStore: {
					mergeInvoiceDoc: vi.fn(),
					clear: vi.fn(),
					resetPostingDate: vi.fn(),
				},
			},
		});
		const onFinishNavigation = vi.fn(() => {
			expect(getActiveInvoiceSubmissionRecovery()).toEqual(
				expect.objectContaining({
					invoiceName: "LOCAL-PRE-DISPATCH-SUCCESS",
				}),
			);
			expect(
				offlineModule.removeInvoiceOutboxEntry,
			).not.toHaveBeenCalled();
		});

		await expect(
			submission.submitInvoice(true, {
				onPrint: vi.fn(),
				onFinishNavigation,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				success: true,
			}),
		);

		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(
			hasInvoiceRecoveryClientEffects(
				invoiceDoc.value.posa_client_request_id,
			),
		).toBe(false);
		expect(onFinishNavigation).toHaveBeenCalledWith(true);
		expect(
			offlineModule.finalizeAcknowledgedInvoiceOutboxEntry,
		).toHaveBeenCalledWith(
			invoiceDoc.value.posa_client_request_id,
			expect.objectContaining({
				invoice: expect.objectContaining({
					name: "LOCAL-PRE-DISPATCH-SUCCESS",
				}),
			}),
			expect.objectContaining({
				acknowledged: true,
				invoice: expect.objectContaining({
					name: "ACC-SINV-PRE-DISPATCH-SUCCESS",
					doctype: "Sales Invoice",
				}),
			}),
		);
		expect(offlineModule.removeInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(submission.submissionRecoveryLocked.value).toBe(false);
		expect(toastStore.show).toHaveBeenCalledTimes(1);
		expect(toastStore.show).not.toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Sale received; confirming status — do not retry",
			}),
		);
	});

	it("leaves a newer cart untouched when a deferred direct response settles", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		let releaseResponse: ((response: any) => void) | undefined;
		let signalDispatch: ((doc: any) => void) | undefined;
		const dispatched = new Promise<any>((resolve) => {
			signalDispatch = resolve;
		});
		(invoiceService.submitInvoice as any).mockImplementationOnce(
			async (_data: any, submittedDoc: any) => {
				signalDispatch?.(submittedDoc);
				return await new Promise((resolve) => {
					releaseResponse = resolve;
				});
			},
		);
		const invoiceDoc = ref<any>({
			name: "LOCAL-DEFERRED-ORIGINAL",
			doctype: "Sales Invoice",
			company: "Test Company",
			pos_profile: "Main POS",
			is_return: 0,
			items: [
				{ posa_row_id: "original-row", item_code: "ITEM-1", qty: 1 },
			],
			payments: [{ mode_of_payment: "Cash", amount: 12, type: "Cash" }],
			rounded_total: 12,
			grand_total: 12,
		});
		const invoiceStore = {
			mergeInvoiceDoc: vi.fn(),
			clear: vi.fn(),
			resetPostingDate: vi.fn(),
		};
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				invoiceStore,
			},
		});

		const pending = submission.submitInvoice(false, callbacks);
		const submittedDoc = await dispatched;
		invoiceDoc.value = {
			name: "LOCAL-DEFERRED-NEWER",
			doctype: "Sales Invoice",
			company: "Test Company",
			pos_profile: "Main POS",
			posa_client_request_id: "newer-cart-request",
			items: [{ posa_row_id: "newer-row", item_code: "ITEM-2", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 20, type: "Cash" }],
			rounded_total: 20,
			grand_total: 20,
		};
		releaseResponse?.({
			name: "ACC-SINV-DEFERRED-ORIGINAL",
			doctype: "Sales Invoice",
			docstatus: 1,
			status: 1,
			client_request_id: submittedDoc.posa_client_request_id,
		});

		const result = await pending;

		expect(result).toEqual(
			expect.objectContaining({
				confirmationPending: true,
				serverAcknowledged: true,
				cartIdentityMismatch: true,
			}),
		);
		expect(invoiceStore.mergeInvoiceDoc).not.toHaveBeenCalled();
		expect(invoiceStore.clear).not.toHaveBeenCalled();
		expect(callbacks.onPrint).not.toHaveBeenCalled();
		expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
		expect(callbacks.onSuccess).not.toHaveBeenCalled();
		expect(invoiceDoc.value.name).toBe("LOCAL-DEFERRED-NEWER");
		expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
			submittedDoc.posa_client_request_id,
		);
	});

	it.each([
		["contradictory submitted fields", { docstatus: 1, status: 0 }],
		["contradictory draft fields", { docstatus: 0, status: 1 }],
		["queued but submitted", { docstatus: 1, status: 1, queued: true }],
		["draft without an explicit queue", { docstatus: 0, status: 0 }],
		[
			"nested contradictory status",
			{
				docstatus: 1,
				status: 1,
				invoice: { docstatus: 0, status: 0 },
			},
		],
	])("keeps a %s direct response in recovery", async (_label, response) => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(
			invoiceService,
			{
				name: "ACC-SINV-CONTRADICTORY",
				doctype: "Sales Invoice",
				...response,
			},
			{ once: true },
		);
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-CONTRADICTORY",
				doctype: "Sales Invoice",
				company: "Test Company",
				pos_profile: "Main POS",
				is_return: 0,
				items: [],
				payments: [
					{ mode_of_payment: "Cash", amount: 8, type: "Cash" },
				],
				rounded_total: 8,
				grand_total: 8,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore: { show: vi.fn() } },
		});

		const result = await submission.submitInvoice(false, callbacks);

		expect(result).toEqual(
			expect.objectContaining({ confirmationPending: true }),
		);
		expect(submission.submissionRecoveryLocked.value).toBe(true);
		expect(callbacks.onPrint).not.toHaveBeenCalled();
		expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
		expect(callbacks.onSuccess).not.toHaveBeenCalled();
		submission.stopSubmissionRecoveryMonitor();
	});

	it("keeps an acknowledged direct response locked when its effects claim cannot persist", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		mockInvoiceSubmissionResponse(
			invoiceService,
			{
				name: "ACC-SINV-DIRECT-CLAIM-FAIL",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
			{ once: true },
		);
		const setItem = Storage.prototype.setItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(function (key, value) {
				if (
					key.startsWith("posa_invoice_recovery_client_effects_v1::")
				) {
					throw new Error("storage unavailable");
				}
				return setItem.call(this, key, value);
			});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-DIRECT-CLAIM-FAIL",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [{ item_code: "ITEM-CLAIM-FAIL", qty: 1 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 18, type: "Cash" },
				],
				rounded_total: 18,
				grand_total: 18,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
			},
		});

		try {
			const result = await submission.submitInvoice(true, callbacks);

			expect(result).toEqual(
				expect.objectContaining({
					confirmationPending: true,
					serverAcknowledged: true,
					clientCompletionFailed: true,
				}),
			);
			expect(submission.submissionRecoveryLocked.value).toBe(true);
			expect(submission.submissionRecovery.value.phase).toBe(
				"manual_review",
			);
			expect(callbacks.onPrint).not.toHaveBeenCalled();
			expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
			expect(callbacks.onSuccess).not.toHaveBeenCalled();
			expect(offlineModule.updateLocalStock).not.toHaveBeenCalled();
			expect(
				offlineModule.removeInvoiceOutboxEntry,
			).not.toHaveBeenCalled();
			expect(getActiveInvoiceSubmissionRecovery()).toEqual(
				expect.objectContaining({
					requestId: expect.any(String),
				}),
			);
		} finally {
			storageSpy.mockRestore();
			consoleError.mockRestore();
		}
	});

	it("contains direct client callback failures behind the acknowledged recovery lock", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		mockInvoiceSubmissionResponse(
			invoiceService,
			{
				name: "ACC-SINV-DIRECT-CALLBACK-FAIL",
				doctype: "Sales Invoice",
				status: 1,
			},
			{ once: true },
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const onPrint = vi.fn(() => {
			throw new Error("print renderer failed");
		});
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-DIRECT-CALLBACK-FAIL",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [{ item_code: "ITEM-CALLBACK-FAIL", qty: 1 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 22, type: "Cash" },
				],
				rounded_total: 22,
				grand_total: 22,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
			},
		});

		try {
			const result = await submission.submitInvoice(true, { onPrint });

			expect(result).toEqual(
				expect.objectContaining({
					confirmationPending: true,
					serverAcknowledged: true,
					clientCompletionFailed: true,
				}),
			);
			expect(onPrint).toHaveBeenCalledTimes(1);
			expect(submission.submissionRecoveryLocked.value).toBe(true);
			expect(offlineModule.updateLocalStock).not.toHaveBeenCalled();
			expect(
				offlineModule.removeInvoiceOutboxEntry,
			).not.toHaveBeenCalled();
			expect(
				hasInvoiceRecoveryClientEffects(
					getActiveInvoiceSubmissionRecovery()?.requestId || "",
				),
			).toBe(true);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("does not let response signal listener failures change an acknowledged sale", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(
			invoiceService,
			{
				name: "ACC-SINV-SIGNAL-SAFE",
				doctype: "Sales Invoice",
				docstatus: 1,
			},
			{ once: true },
		);
		const dispatchEvent = window.dispatchEvent.bind(window);
		const dispatchSpy = vi
			.spyOn(window, "dispatchEvent")
			.mockImplementation((event) => {
				if (
					[
						"posa:invoice-submit-response",
						"posa:invoice-submit-authoritative",
					].includes(event.type)
				) {
					throw new Error("observer failed");
				}
				return dispatchEvent(event);
			});
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-SIGNAL-SAFE",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [],
				payments: [
					{ mode_of_payment: "Cash", amount: 9, type: "Cash" },
				],
				rounded_total: 9,
				grand_total: 9,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
			},
		});

		try {
			await expect(submission.submitInvoice(false)).resolves.toEqual(
				expect.objectContaining({ success: true }),
			);
			expect(submission.submissionRecoveryLocked.value).toBe(false);
			expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
			expect(consoleWarn).toHaveBeenCalledWith(
				"Unable to publish invoice response browser signal",
				expect.any(Error),
			);
			expect(consoleWarn).toHaveBeenCalledWith(
				"Unable to publish authoritative invoice browser signal",
				expect.any(Error),
			);
		} finally {
			dispatchSpy.mockRestore();
			consoleWarn.mockRestore();
		}
	});

	it("keeps an acknowledged sale locked when its active pointer cannot be cleared", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		mockInvoiceSubmissionResponse(
			invoiceService,
			{
				name: "ACC-SINV-POINTER-CLEAR-FAIL",
				doctype: "Sales Invoice",
				status: 1,
			},
			{ once: true },
		);
		const removeItem = Storage.prototype.removeItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "removeItem")
			.mockImplementation(function (key) {
				if (key === "posa_active_invoice_submission_recovery_v1") {
					throw new Error("storage unavailable");
				}
				return removeItem.call(this, key);
			});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-POINTER-CLEAR-FAIL",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [],
				payments: [
					{ mode_of_payment: "Cash", amount: 11, type: "Cash" },
				],
				rounded_total: 11,
				grand_total: 11,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
			},
		});

		try {
			const result = await submission.submitInvoice(false, {
				onFinishNavigation: vi.fn(),
			});
			const requestId =
				getActiveInvoiceSubmissionRecovery()?.requestId || "";

			expect(result).toEqual(
				expect.objectContaining({
					confirmationPending: true,
					serverAcknowledged: true,
					clientCompletionFailed: true,
				}),
			);
			expect(submission.submissionRecoveryLocked.value).toBe(true);
			expect(requestId).not.toBe("");
			expect(hasInvoiceRecoveryClientEffects(requestId)).toBe(true);
			expect(
				offlineModule.removeInvoiceOutboxEntry,
			).not.toHaveBeenCalled();
		} finally {
			storageSpy.mockRestore();
			consoleError.mockRestore();
			consoleWarn.mockRestore();
		}
	});

	it("restores a synchronous lock with empty Pinia while IndexedDB enqueue is unresolved", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		let signalDispatch: ((submittedDoc: any) => void) | undefined;
		const dispatched = new Promise<any>((resolve) => {
			signalDispatch = resolve;
		});
		(offlineModule.enqueueInvoiceOutboxEntry as any).mockImplementationOnce(
			(intent: any) => {
				expect(getActiveInvoiceSubmissionRecovery()).toEqual(
					expect.objectContaining({
						requestId: intent.invoice.posa_client_request_id,
						invoiceName: "LOCAL-UNRESOLVED-ENQUEUE",
					}),
				);
				return new Promise(() => undefined);
			},
		);
		(invoiceService.submitInvoice as any).mockImplementationOnce(
			async (_data: any, submittedDoc: any) => {
				signalDispatch?.(submittedDoc);
				return await new Promise(() => undefined);
			},
		);
		const firstToastStore = { show: vi.fn() };
		const firstSubmission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-UNRESOLVED-ENQUEUE",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [{ item_code: "ITEM-UNRESOLVED", qty: 1 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 15, type: "Cash" },
				],
				rounded_total: 15,
				grand_total: 15,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore: firstToastStore },
		});
		void firstSubmission.submitInvoice(false);

		const dispatchedDoc = await dispatched;
		expect(firstToastStore.show).not.toHaveBeenCalled();
		resetInvoiceRecoveryMemoryForTests();
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([]);
		const syncStore = { syncPendingInvoices: vi.fn(async () => undefined) };
		const remountedSubmission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { syncStore, toastStore: { show: vi.fn() } },
		});

		const resumePromise =
			remountedSubmission.resumePendingSubmissionRecovery();
		expect(remountedSubmission.submissionRecoveryLocked.value).toBe(true);
		expect(remountedSubmission.submissionRecovery.value).toEqual(
			expect.objectContaining({
				phase: "confirming",
				requestId: dispatchedDoc.posa_client_request_id,
				invoiceName: "LOCAL-UNRESOLVED-ENQUEUE",
			}),
		);
		await resumePromise;
		await vi.waitFor(() => {
			expect(syncStore.syncPendingInvoices).toHaveBeenCalledWith({
				showToasts: false,
				transactionalOnly: true,
			});
		});
		remountedSubmission.stopSubmissionRecoveryMonitor();
	});

	it("recovers a dispatched request after a crash remount with an empty Pinia invoice", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		let signalDispatch: ((submittedDoc: any) => void) | undefined;
		const dispatched = new Promise<any>((resolve) => {
			signalDispatch = resolve;
		});
		(invoiceService.submitInvoice as any).mockImplementationOnce(
			async (_data: any, submittedDoc: any) => {
				signalDispatch?.(submittedDoc);
				return await new Promise(() => undefined);
			},
		);
		const firstToastStore = { show: vi.fn() };
		const firstSubmission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-CRASH-BOUNDARY",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [{ item_code: "ITEM-CRASH", qty: 2 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 50, type: "Cash" },
				],
				rounded_total: 50,
				grand_total: 50,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore: firstToastStore },
		});
		void firstSubmission.submitInvoice(true, {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
		});

		const dispatchedDoc = await dispatched;
		expect(getActiveInvoiceSubmissionRecovery()).toEqual(
			expect.objectContaining({
				requestId: dispatchedDoc.posa_client_request_id,
				invoiceName: "LOCAL-CRASH-BOUNDARY",
				printRequested: true,
			}),
		);
		expect(firstToastStore.show).not.toHaveBeenCalled();
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([
			{
				client_request_id: dispatchedDoc.posa_client_request_id,
				status: "acknowledged",
				invoice_name: "ACC-SINV-CRASH-BOUNDARY",
				invoice: {
					doctype: "Sales Invoice",
					items: [{ item_code: "ITEM-CRASH", qty: 2 }],
				},
			},
		]);
		resetInvoiceRecoveryMemoryForTests();
		const remountCallbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const remountedSubmission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				invoiceStore: {
					mergeInvoiceDoc: vi.fn(),
					clear: vi.fn(),
					resetPostingDate: vi.fn(),
				},
			},
		});

		const result =
			await remountedSubmission.resumePendingSubmissionRecovery(
				remountCallbacks,
			);

		expect(result).toEqual(
			expect.objectContaining({
				confirmed: true,
				clientEffectsApplied: true,
			}),
		);
		expect(remountCallbacks.onPrint).toHaveBeenCalledTimes(1);
		expect(remountCallbacks.onFinishNavigation).toHaveBeenCalledWith(true);
		expect(remountCallbacks.onSuccess).toHaveBeenCalledTimes(1);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
	});

	it("does not clear another tab's cart while settling an acknowledged recovery", async () => {
		const offlineModule = await import("../src/offline/index");
		const originalCart = {
			name: "LOCAL-TAB-ORIGINAL",
			doctype: "Sales Invoice",
			company: "Test Company",
			pos_profile: "Main POS",
			items: [
				{
					posa_row_id: "tab-original-row",
					item_code: "ITEM-1",
					qty: 1,
				},
			],
			payments: [{ mode_of_payment: "Cash", amount: 14, type: "Cash" }],
			grand_total: 14,
			rounded_total: 14,
		};
		persistScopedRecovery({
			requestId: "req-tab-original",
			invoiceName: originalCart.name,
			cartFingerprint: buildInvoiceRecoveryCartFingerprint(originalCart),
			printRequested: false,
		});
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([
			{
				client_request_id: "req-tab-original",
				status: "acknowledged",
				invoice_name: "ACC-SINV-TAB-ORIGINAL",
				invoice: {
					doctype: "Sales Invoice",
					items: originalCart.items,
				},
			},
		]);
		const newerCart = ref<any>({
			name: "LOCAL-TAB-NEWER",
			doctype: "Sales Invoice",
			company: "Test Company",
			pos_profile: "Main POS",
			posa_client_request_id: "req-tab-newer",
			items: [
				{ posa_row_id: "tab-newer-row", item_code: "ITEM-2", qty: 1 },
			],
			payments: [{ mode_of_payment: "Cash", amount: 21, type: "Cash" }],
			grand_total: 21,
			rounded_total: 21,
		});
		const invoiceStore = {
			mergeInvoiceDoc: vi.fn(),
			clear: vi.fn(),
			resetPostingDate: vi.fn(),
		};
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc: newerCart,
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				invoiceStore,
			},
		});

		const result =
			await submission.resumePendingSubmissionRecovery(callbacks);

		expect(result).toEqual(
			expect.objectContaining({
				confirmed: true,
				manualReview: true,
				cartIdentityMismatch: true,
			}),
		);
		expect(invoiceStore.mergeInvoiceDoc).not.toHaveBeenCalled();
		expect(invoiceStore.clear).not.toHaveBeenCalled();
		expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
		expect(newerCart.value.name).toBe("LOCAL-TAB-NEWER");
		expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
			"req-tab-original",
		);
	});

	it("does not accept a matching fingerprint for a nonempty cart without the recovery request ID", async () => {
		const offlineModule = await import("../src/offline/index");
		const originalCart = {
			name: "LOCAL-MISSING-REQUEST-ID",
			doctype: "Sales Invoice",
			company: "Test Company",
			pos_profile: "Main POS",
			items: [
				{
					posa_row_id: "missing-request-row",
					item_code: "ITEM-REQUEST",
					qty: 1,
				},
			],
			payments: [{ mode_of_payment: "Cash", amount: 18, type: "Cash" }],
			grand_total: 18,
			rounded_total: 18,
		};
		persistScopedRecovery({
			requestId: "req-missing-from-cart",
			invoiceName: originalCart.name,
			cartFingerprint: buildInvoiceRecoveryCartFingerprint(originalCart),
			printRequested: false,
		});
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([
			{
				client_request_id: "req-missing-from-cart",
				status: "acknowledged",
				invoice_name: "ACC-SINV-MISSING-REQUEST-ID",
				invoice: {
					doctype: "Sales Invoice",
					items: originalCart.items,
				},
			},
		]);
		const invoiceDoc = ref<any>({ ...originalCart });
		const invoiceStore = {
			mergeInvoiceDoc: vi.fn(),
			clear: vi.fn(),
			resetPostingDate: vi.fn(),
		};
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				invoiceStore,
			},
		});

		const result =
			await submission.resumePendingSubmissionRecovery(callbacks);

		expect(result).toEqual(
			expect.objectContaining({
				confirmed: true,
				manualReview: true,
				cartIdentityMismatch: true,
			}),
		);
		expect(invoiceStore.mergeInvoiceDoc).not.toHaveBeenCalled();
		expect(invoiceStore.clear).not.toHaveBeenCalled();
		expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
		expect(invoiceDoc.value.posa_client_request_id).toBeUndefined();
		expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
			"req-missing-from-cart",
		);
	});

	it("does not dispatch when the pre-dispatch recovery pointer cannot be persisted", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const setItem = Storage.prototype.setItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(function (key, value) {
				if (key === "posa_active_invoice_submission_recovery_v1") {
					throw new Error("storage unavailable");
				}
				return setItem.call(this, key, value);
			});
		const toastStore = { show: vi.fn() };
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "LOCAL-POINTER-FAIL-CLOSED",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [{ item_code: "ITEM-FAIL", qty: 1 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 20, type: "Cash" },
				],
				rounded_total: 20,
				grand_total: 20,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore },
		});

		try {
			let thrown: any;
			try {
				await submission.submitInvoice(false);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toEqual(
				expect.objectContaining({
					code: "RECOVERY_PERSISTENCE_FAILED",
					posaRecoveryPersistenceFailed: true,
					posaToastHandled: true,
				}),
			);
			expect(invoiceService.submitInvoice).not.toHaveBeenCalled();
			expect(
				offlineModule.enqueueInvoiceOutboxEntry,
			).not.toHaveBeenCalled();
			expect(offlineModule.removeInvoiceOutboxEntry).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					invoice: expect.objectContaining({
						name: "LOCAL-POINTER-FAIL-CLOSED",
					}),
				}),
				"pending",
			);
			expect(
				offlineModule.removeInvoiceIntentJournal,
			).not.toHaveBeenCalled();
			expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
			expect(submission.submissionRecoveryLocked.value).toBe(false);
			expect(toastStore.show).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Sale not sent",
					color: "error",
				}),
			);
		} finally {
			storageSpy.mockRestore();
			consoleError.mockRestore();
		}
	});

	it("does not lock a pre-dispatch stock lookup failure", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		(globalThis as any).frappe.call = vi
			.fn()
			.mockRejectedValue(new TypeError("Failed to fetch"));

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-PRE-DISPATCH",
			doctype: "Sales Invoice",
			update_stock: 1,
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1, warehouse: "Stores" }],
			payments: [{ mode_of_payment: "Cash", amount: 50, type: "Cash" }],
			rounded_total: 50,
			grand_total: 50,
		});
		const toastStore = { show: vi.fn() };
		const { submitInvoice, submissionRecoveryLocked } =
			usePaymentSubmission({
				invoiceDoc,
				posProfile: ref({
					name: "Main POS",
					posa_allow_submissions_in_background_job: 0,
				}),
				stockSettings: ref({}),
				invoiceType: ref("Invoice"),
				formatFloat: (value) => Number(value || 0),
				stores: { toastStore },
				isCashback: ref(false),
				paidChange: ref(0),
				creditChange: ref(0),
				redeemedCustomerCredit: ref(0),
				customerCreditDict: ref([]),
				diff_payment: ref(0),
			});

		await expect(submitInvoice(false)).rejects.toThrow("Failed to fetch");

		expect(submissionRecoveryLocked.value).toBe(false);
		expect(invoiceService.submitInvoice).not.toHaveBeenCalled();
		expect(toastStore.show).toHaveBeenCalledTimes(1);
		consoleError.mockRestore();
	});

	it("moves a dead letter to supervisor review and settles its acknowledgement once", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		const stockCoordinator = (
			await import("../src/posapp/utils/stockCoordinator")
		).default;
		(invoiceService.submitInvoice as any).mockRejectedValueOnce(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "ABORTED",
					message: "Request was cancelled",
					retryable: false,
				},
				requestId: "transport-abort-001",
				serverTime: null,
			}),
		);
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const invoiceDoc = ref<any>({
			name: "LOCAL-SINV-RECOVERY",
			doctype: "Sales Invoice",
			pos_profile: "Main POS",
			company: "Test Company",
			is_return: 0,
			items: [{ item_code: "ITEM-RECOVERY", qty: 2 }],
			payments: [{ mode_of_payment: "Cash", amount: 50, type: "Cash" }],
			rounded_total: 50,
			grand_total: 50,
		});
		(offlineModule.getInvoiceOutboxRows as any).mockImplementation(
			async () => [
				{
					client_request_id: invoiceDoc.value.posa_client_request_id,
					status: "dead_letter",
					invoice: JSON.parse(JSON.stringify(invoiceDoc.value)),
					invoice_name: null,
					last_error: "confirmation retry limit reached",
				},
			],
		);
		const toastStore = { show: vi.fn() };
		const syncStore = { syncPendingInvoices: vi.fn(async () => undefined) };
		const uiStore = {
			setLastInvoice: vi.fn(),
			setLastStockAdjustment: vi.fn(),
		};
		const onFinishNavigation = vi.fn();
		const onSuccess = vi.fn();
		const onPrint = vi.fn();

		const {
			submitInvoice,
			submissionRecovery,
			manuallyReconcilePendingSubmission,
		} = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				posa_allow_submissions_in_background_job: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore,
				syncStore,
				uiStore,
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: {
					mergeInvoiceDoc: vi.fn(),
					clear: vi.fn(),
					resetPostingDate: vi.fn(),
				},
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await submitInvoice(true, {
			onFinishNavigation,
			onSuccess,
			onPrint,
		});
		await vi.waitFor(() => {
			expect(submissionRecovery.value.phase).toBe("manual_review");
		});

		(globalThis as any).frappe.call = vi.fn().mockResolvedValue({
			message: {
				acknowledged: true,
				client_request_id: invoiceDoc.value.posa_client_request_id,
				invoice: {
					name: "ACC-SINV-RECOVERED",
					doctype: "Sales Invoice",
					docstatus: 1,
				},
			},
		});
		const firstSettlement = await manuallyReconcilePendingSubmission();
		const secondSettlement = await manuallyReconcilePendingSubmission();

		expect(firstSettlement).toEqual(
			expect.objectContaining({ confirmed: true }),
		);
		expect(secondSettlement).toEqual({
			confirmed: true,
			alreadySettled: true,
		});
		expect(onFinishNavigation).toHaveBeenCalledTimes(1);
		expect(onFinishNavigation).toHaveBeenCalledWith(true);
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onPrint).toHaveBeenCalledTimes(1);
		expect(offlineModule.removeInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(
			offlineModule.removeInvoiceIntentJournalStrict,
		).toHaveBeenCalledTimes(1);
		expect(offlineModule.updateLocalStock).toHaveBeenCalledTimes(1);
		expect(stockCoordinator.applyInvoiceConsumption).toHaveBeenCalledTimes(
			1,
		);
		expect(uiStore.setLastStockAdjustment).toHaveBeenCalledTimes(1);
		expect(uiStore.setLastInvoice).toHaveBeenCalledWith(
			"ACC-SINV-RECOVERED",
		);
		expect(toastStore.show).toHaveBeenCalledTimes(3);
		consoleWarn.mockRestore();
	});

	it("restores a durable lock by request ID with an empty Pinia invoice", async () => {
		const offlineModule = await import("../src/offline/index");
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([]);
		persistScopedRecovery({
			requestId: "req-durable-lock",
			invoiceName: "LOCAL-DRAFT-LOCK",
			printRequested: false,
		});
		const syncStore = { syncPendingInvoices: vi.fn(async () => undefined) };
		const toastStore = { show: vi.fn() };
		const {
			resumePendingSubmissionRecovery,
			submissionRecovery,
			submissionRecoveryLocked,
			stopSubmissionRecoveryMonitor,
		} = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { syncStore, toastStore },
		});

		await resumePendingSubmissionRecovery();

		expect(submissionRecoveryLocked.value).toBe(true);
		expect(submissionRecovery.value).toEqual(
			expect.objectContaining({
				phase: "confirming",
				requestId: "req-durable-lock",
				invoiceName: "LOCAL-DRAFT-LOCK",
			}),
		);
		await vi.waitFor(() => {
			expect(syncStore.syncPendingInvoices).toHaveBeenCalledWith({
				showToasts: false,
				transactionalOnly: true,
			});
		});
		expect(toastStore.show).toHaveBeenCalledTimes(1);
		stopSubmissionRecoveryMonitor();
	});

	it("locks immediately and enters supervisor review when the restored outbox cannot be read", async () => {
		const offlineModule = await import("../src/offline/index");
		(offlineModule.getInvoiceOutboxRows as any).mockRejectedValueOnce(
			new Error("IndexedDB unavailable"),
		);
		persistScopedRecovery({
			requestId: "req-outbox-read-failure",
			invoiceName: "LOCAL-OUTBOX-READ-FAILURE",
			printRequested: false,
		});
		const toastStore = { show: vi.fn() };
		const submission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: { toastStore },
		});

		const resumePromise = submission.resumePendingSubmissionRecovery();
		expect(submission.submissionRecoveryLocked.value).toBe(true);
		expect(submission.submissionRecovery.value.phase).toBe("confirming");
		const result = await resumePromise;

		expect(result).toEqual(
			expect.objectContaining({
				phase: "manual_review",
				requestId: "req-outbox-read-failure",
				outboxReadFailed: true,
			}),
		);
		expect(submission.submissionRecoveryLocked.value).toBe(true);
		expect(submission.submissionRecovery.value.phase).toBe("manual_review");
		expect(toastStore.show).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Sale needs supervisor status confirmation",
				color: "error",
				timeout: -1,
			}),
		);
		expect(getActiveInvoiceSubmissionRecovery()).toEqual(
			expect.objectContaining({
				requestId: "req-outbox-read-failure",
			}),
		);
	});

	it("claims recovered print, stock, and callbacks once across a remount", async () => {
		const offlineModule = await import("../src/offline/index");
		const stockCoordinator = (
			await import("../src/posapp/utils/stockCoordinator")
		).default;
		const acknowledgedRow = {
			client_request_id: "req-remount-once",
			status: "acknowledged",
			invoice_name: "ACC-SINV-REMOUNT-1",
			invoice: {
				name: "LOCAL-DRAFT-REMOUNT",
				doctype: "Sales Invoice",
				docstatus: 0,
				items: [{ item_code: "ITEM-REMOUNT", qty: 3 }],
			},
		};
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([
			acknowledgedRow,
		]);
		persistScopedRecovery({
			requestId: "req-remount-once",
			invoiceName: "LOCAL-DRAFT-REMOUNT",
			printRequested: true,
		});

		const firstCallbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const firstUiStore = {
			setLastInvoice: vi.fn(),
			setLastStockAdjustment: vi.fn(),
		};
		const firstSubmission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: firstUiStore,
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: {
					mergeInvoiceDoc: vi.fn(),
					clear: vi.fn(),
					resetPostingDate: vi.fn(),
				},
			},
		});
		const firstResult =
			await firstSubmission.resumePendingSubmissionRecovery(
				firstCallbacks,
			);

		expect(firstResult).toEqual(
			expect.objectContaining({
				confirmed: true,
				clientEffectsApplied: true,
			}),
		);
		expect(firstCallbacks.onPrint).toHaveBeenCalledTimes(1);
		expect(firstCallbacks.onFinishNavigation).toHaveBeenCalledTimes(1);
		expect(firstCallbacks.onSuccess).toHaveBeenCalledTimes(1);
		expect(offlineModule.updateLocalStock).toHaveBeenCalledTimes(1);
		expect(stockCoordinator.applyInvoiceConsumption).toHaveBeenCalledTimes(
			1,
		);
		expect(firstUiStore.setLastStockAdjustment).toHaveBeenCalledTimes(1);
		expect(firstUiStore.setLastInvoice).toHaveBeenCalledWith(
			"ACC-SINV-REMOUNT-1",
		);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(hasInvoiceRecoveryClientEffects("req-remount-once")).toBe(false);

		// Simulate a reload at the durable boundary where the active pointer was
		// restored but the first component had already claimed its client effects.
		persistScopedRecovery({
			requestId: "req-remount-once",
			invoiceName: "LOCAL-DRAFT-REMOUNT",
			printRequested: true,
		});
		expect(claimInvoiceRecoveryClientEffects("req-remount-once")).toBe(
			true,
		);
		resetInvoiceRecoveryMemoryForTests();
		const secondCallbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const secondUiStore = {
			setLastInvoice: vi.fn(),
			setLastStockAdjustment: vi.fn(),
		};
		const secondInvoiceStore = {
			mergeInvoiceDoc: vi.fn(),
			clear: vi.fn(),
			resetPostingDate: vi.fn(),
		};
		const secondSubmission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: secondUiStore,
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: secondInvoiceStore,
			},
		});
		const secondResult =
			await secondSubmission.resumePendingSubmissionRecovery(
				secondCallbacks,
			);

		expect(secondResult).toEqual(
			expect.objectContaining({
				confirmed: true,
				alreadySettled: true,
				clientEffectsApplied: false,
			}),
		);
		expect(secondCallbacks.onPrint).not.toHaveBeenCalled();
		expect(secondCallbacks.onFinishNavigation).toHaveBeenCalledTimes(1);
		expect(secondCallbacks.onFinishNavigation).toHaveBeenCalledWith(true);
		expect(secondCallbacks.onSuccess).not.toHaveBeenCalled();
		expect(offlineModule.updateLocalStock).toHaveBeenCalledTimes(1);
		expect(stockCoordinator.applyInvoiceConsumption).toHaveBeenCalledTimes(
			1,
		);
		expect(secondUiStore.setLastStockAdjustment).not.toHaveBeenCalled();
		expect(secondUiStore.setLastInvoice).toHaveBeenCalledWith(
			"ACC-SINV-REMOUNT-1",
		);
		expect(secondInvoiceStore.mergeInvoiceDoc).toHaveBeenCalledWith({
			name: "ACC-SINV-REMOUNT-1",
			doctype: "Sales Invoice",
			docstatus: 1,
		});
		expect(secondInvoiceStore.clear).toHaveBeenCalledTimes(1);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(hasInvoiceRecoveryClientEffects("req-remount-once")).toBe(false);
	});

	it("keeps an acknowledged sale locked when its effects claim cannot be persisted", async () => {
		const offlineModule = await import("../src/offline/index");
		const stockCoordinator = (
			await import("../src/posapp/utils/stockCoordinator")
		).default;
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([
			{
				client_request_id: "req-effects-fail-closed",
				status: "acknowledged",
				invoice_name: "ACC-SINV-EFFECTS-FAIL",
				invoice: {
					doctype: "Sales Invoice",
					items: [{ item_code: "ITEM-FAIL-CLOSED", qty: 1 }],
				},
			},
		]);
		persistScopedRecovery({
			requestId: "req-effects-fail-closed",
			invoiceName: "LOCAL-EFFECTS-FAIL",
			printRequested: true,
		});

		const setItem = Storage.prototype.setItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(function (key, value) {
				if (
					key.startsWith("posa_invoice_recovery_client_effects_v1::")
				) {
					throw new Error("storage unavailable");
				}
				return setItem.call(this, key, value);
			});
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const uiStore = {
			setLastInvoice: vi.fn(),
			setLastStockAdjustment: vi.fn(),
		};
		const invoiceStore = { mergeInvoiceDoc: vi.fn() };
		const submission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore,
				invoiceStore,
			},
		});

		try {
			const result =
				await submission.resumePendingSubmissionRecovery(callbacks);

			expect(result).toEqual(
				expect.objectContaining({
					confirmed: false,
					manualReview: true,
					persistenceFailed: true,
				}),
			);
			expect(submission.submissionRecovery.value.phase).toBe(
				"manual_review",
			);
			expect(submission.submissionRecoveryLocked.value).toBe(true);
			expect(callbacks.onPrint).not.toHaveBeenCalled();
			expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
			expect(callbacks.onSuccess).not.toHaveBeenCalled();
			expect(
				(globalThis as any).frappe.utils.play_sound,
			).not.toHaveBeenCalled();
			expect(offlineModule.updateLocalStock).not.toHaveBeenCalled();
			expect(
				stockCoordinator.applyInvoiceConsumption,
			).not.toHaveBeenCalled();
			expect(uiStore.setLastInvoice).not.toHaveBeenCalled();
			expect(uiStore.setLastStockAdjustment).not.toHaveBeenCalled();
			expect(invoiceStore.mergeInvoiceDoc).not.toHaveBeenCalled();
			expect(getActiveInvoiceSubmissionRecovery()).toEqual(
				expect.objectContaining({
					requestId: "req-effects-fail-closed",
				}),
			);
		} finally {
			storageSpy.mockRestore();
		}
	});

	it.each([
		["empty", undefined],
		["null", null],
		["unacknowledged", { message: { acknowledged: false } }],
		[
			"fallback-only identity",
			{
				message: {
					acknowledged: true,
					client_request_id: "req-unacknowledged",
					status: 1,
				},
			},
		],
		[
			"status zero",
			{
				message: {
					acknowledged: false,
					invoice: { name: "LOCAL-ONLY", docstatus: 0 },
				},
			},
		],
		[
			"mismatched request identity",
			{
				message: {
					acknowledged: true,
					client_request_id: "different-request",
					invoice: {
						name: "ACC-SINV-STALE",
						doctype: "Sales Invoice",
						docstatus: 1,
					},
				},
			},
		],
		[
			"wrong submitted document type",
			{
				message: {
					acknowledged: true,
					client_request_id: "req-unacknowledged",
					invoice: {
						name: "SAL-ORD-STALE",
						doctype: "Sales Order",
						docstatus: 1,
					},
				},
			},
		],
	])("does not settle a %s supervisor response", async (_label, response) => {
		const offlineModule = await import("../src/offline/index");
		persistScopedRecovery({
			requestId: "req-unacknowledged",
			invoiceName: "LOCAL-UNACKNOWLEDGED",
			printRequested: true,
		});
		(offlineModule.getInvoiceOutboxRows as any).mockResolvedValue([
			{
				client_request_id: "req-unacknowledged",
				status: "dead_letter",
				invoice_name: null,
				invoice: { name: "LOCAL-UNACKNOWLEDGED", items: [] },
				last_error: "automatic retries exhausted",
			},
		]);
		(globalThis as any).frappe.call = vi.fn().mockResolvedValue(response);
		const callbacks = {
			onPrint: vi.fn(),
			onFinishNavigation: vi.fn(),
			onSuccess: vi.fn(),
		};
		const submission = usePaymentSubmission({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
			},
		});

		await submission.resumePendingSubmissionRecovery(callbacks);
		const result = await submission.manuallyReconcilePendingSubmission();

		expect(result).toEqual(expect.objectContaining({ confirmed: false }));
		expect(submission.submissionRecovery.value.phase).toBe("manual_review");
		expect(callbacks.onPrint).not.toHaveBeenCalled();
		expect(callbacks.onFinishNavigation).not.toHaveBeenCalled();
		expect(callbacks.onSuccess).not.toHaveBeenCalled();
		expect(offlineModule.updateLocalStock).not.toHaveBeenCalled();
		expect(getActiveInvoiceSubmissionRecovery()?.requestId).toBe(
			"req-unacknowledged",
		);
	});

	it("normalizes loyalty redemption fields before online submit", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-LOYALTY-ONLINE",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-LOYALTY-ONLINE",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "CUST-LOYALTY",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 60, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			loyalty_amount: 0,
			redeem_loyalty_points: 0,
			loyalty_points: 0,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
			loyaltyAmount: ref(40),
			customerInfo: ref({
				name: "CUST-LOYALTY",
				loyalty_program: "Retail Loyalty",
				conversion_factor: 10,
			}),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc).toEqual(
			expect.objectContaining({
				loyalty_amount: 40,
				redeem_loyalty_points: 1,
				loyalty_points: 4,
				loyalty_program: "Retail Loyalty",
			}),
		);
	});

	it("recomputes loyalty points when explicit loyalty amount differs from document amount", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-LOYALTY-STALE",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-LOYALTY-STALE",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "CUST-LOYALTY",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 80, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			loyalty_amount: 10,
			redeem_loyalty_points: 1,
			loyalty_points: 1,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
			loyaltyAmount: ref(20),
			customerInfo: ref({
				name: "CUST-LOYALTY",
				loyalty_program: "Retail Loyalty",
				conversion_factor: 10,
			}),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc).toEqual(
			expect.objectContaining({
				loyalty_amount: 20,
				redeem_loyalty_points: 1,
				loyalty_points: 2,
			}),
		);
	});

	it("clears stale document loyalty redemption when explicit loyalty amount is zero", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-LOYALTY-CLEAR",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-LOYALTY-CLEAR",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "CUST-LOYALTY",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 100, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			loyalty_amount: 10,
			redeem_loyalty_points: 1,
			loyalty_points: 1,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
			loyaltyAmount: ref(0),
			customerInfo: ref({
				name: "CUST-LOYALTY",
				loyalty_program: "Retail Loyalty",
				conversion_factor: 10,
			}),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc).toEqual(
			expect.objectContaining({
				loyalty_amount: 0,
				redeem_loyalty_points: 0,
				loyalty_points: 0,
			}),
		);
	});

	it("derives loyalty points from company currency during multi-currency submit", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-LOYALTY-MULTI",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-LOYALTY-MULTI",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "CUST-LOYALTY",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 280,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 90, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			loyalty_amount: 0,
			redeem_loyalty_points: 0,
			loyalty_points: 0,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "PKR",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
			loyaltyAmount: ref(10),
			customerInfo: ref({
				name: "CUST-LOYALTY",
				loyalty_program: "Retail Loyalty",
				conversion_factor: 70,
			}),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc).toEqual(
			expect.objectContaining({
				loyalty_amount: 10,
				redeem_loyalty_points: 1,
				loyalty_points: 40,
				loyalty_program: "Retail Loyalty",
			}),
		);
	});

	it("clears loyalty redemption when amount is too small to redeem one point", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-LOYALTY-TINY",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-LOYALTY-TINY",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "CUST-LOYALTY",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 100, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			loyalty_amount: 0,
			redeem_loyalty_points: 0,
			loyalty_points: 0,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
			loyaltyAmount: ref(0.5),
			customerInfo: ref({
				name: "CUST-LOYALTY",
				loyalty_program: "Retail Loyalty",
				conversion_factor: 10,
			}),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc).toEqual(
			expect.objectContaining({
				loyalty_amount: 0,
				redeem_loyalty_points: 0,
				loyalty_points: 0,
			}),
		);
	});

	it("blocks offline final invoice submission without saving an unsigned invoice", async () => {
		const offlineModule = await import("../src/offline/index");
		(offlineModule.isOffline as any).mockReturnValue(true);

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-LOYALTY-OFFLINE",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "CUST-LOYALTY",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 60, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
			loyalty_amount: 0,
			redeem_loyalty_points: 0,
			loyalty_points: 0,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				customer: "Default Customer",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				syncStore: { updatePendingCount: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
			loyaltyAmount: ref(40),
			customerInfo: ref({
				name: "CUST-LOYALTY",
				loyalty_program: "Retail Loyalty",
				conversion_factor: 10,
			}),
		});

		await expect(
			submitInvoice(false, {
				onFinishNavigation: vi.fn(),
			}),
		).rejects.toThrow("No prepared offline cash-sale authorization");

		expect(offlineModule.saveOfflineInvoice).not.toHaveBeenCalled();

		(offlineModule.isOffline as any).mockReturnValue(false);
	});

	it("blocks offline invoice save when gift card redemption is present", async () => {
		const offlineModule = await import("../src/offline/index");
		(offlineModule.isOffline as any).mockReturnValue(true);

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0006",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [
				{ mode_of_payment: "Gift Card", amount: 300, type: "Bank" },
			],
			rounded_total: 300,
			grand_total: 300,
		});

		const giftCardRedemptions = ref([
			{
				gift_card_code: "GC-0002",
				amount: 300,
				cashier: "cashier@example.com",
			},
		]);

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				syncStore: { updatePendingCount: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			giftCardRedemptions,
			diff_payment: ref(0),
		});

		await expect(
			submitInvoice(false, {
				onFinishNavigation: vi.fn(),
			}),
		).rejects.toThrow("No prepared offline cash-sale authorization");

		expect(offlineModule.saveOfflineInvoice).not.toHaveBeenCalled();

		(offlineModule.isOffline as any).mockReturnValue(false);
	});

	it("queues one prepared cash-only ticket offline without persisting a PIN", async () => {
		const offlineModule = await import("../src/offline/index");
		(offlineModule.isOffline as any).mockReturnValue(true);
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const onSuccess = vi.fn();
		const onFinishNavigation = vi.fn();
		const invoiceDoc = ref<any>({
			doctype: "Sales Invoice",
			is_pos: 1,
			is_return: 0,
			pos_profile: "Main POS",
			company: "Test Company",
			company_currency: "PKR",
			currency: "PKR",
			items: [{ item_code: "ITEM-OFFLINE", qty: 1 }],
			payments: [
				{ mode_of_payment: "Cash", amount: 125, base_amount: 125, type: "Cash" },
			],
			base_rounded_total: 125,
			rounded_total: 125,
			grand_total: 125,
		});
		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				create_pos_invoice_instead_of_sales_invoice: 0,
				posa_allow_submissions_in_background_job: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: { setLastStockAdjustment: vi.fn() },
				invoiceStore: { items: invoiceDoc.value.items },
			},
			isCashback: ref(true),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});
		const ticket = {
			authorization: "signed-offline-ticket",
			client_request_id: "offline-ticket-request-001",
			owner_user: "cashier@example.test",
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			cashier: "cashier@example.test",
			cash_mode_of_payment: "Cash",
			maximum_amount: "500",
			company_currency: "PKR",
			document_type: "Sales Invoice" as const,
		};
		await expect(
			submitInvoice(
				false,
				{ onSuccess, onFinishNavigation },
				{
					cashierSignature: {
						cashierPin: "",
						offlineSaleAuthorization: {
							...ticket,
							owner_user: "other-cashier@example.test",
						},
					},
				},
			),
		).rejects.toThrow("different signed-in user");
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
		invoiceDoc.value.customer = "TEMP CUSTOMER OFFLINE";
		(offlineModule.getOfflineCustomers as any).mockReturnValue([
			{ args: { customer_name: "TEMP CUSTOMER OFFLINE" } },
		]);
		await expect(
			submitInvoice(
				false,
				{ onSuccess, onFinishNavigation },
				{ cashierSignature: { cashierPin: "", offlineSaleAuthorization: ticket } },
			),
		).rejects.toThrow("cannot use a customer created while offline");
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
		delete invoiceDoc.value.customer;
		(offlineModule.getOfflineCustomers as any).mockReturnValue([]);

		await expect(
			submitInvoice(
				false,
				{ onSuccess, onFinishNavigation },
				{ cashierSignature: { cashierPin: "", offlineSaleAuthorization: ticket } },
			),
		).resolves.toMatchObject({ queued: true, offline: true });

		expect(invoiceDoc.value.posa_client_request_id).toBe(
			"offline-ticket-request-001",
		);
		expect(offlineModule.enqueueInvoiceOutboxEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				offline_sale_authorization: "signed-offline-ticket",
				invoice: expect.not.objectContaining({
					offline_sale_authorization: expect.anything(),
					cashier_pin: expect.anything(),
				}),
				data: expect.not.objectContaining({
					offline_sale_authorization: expect.anything(),
					cashier_pin: expect.anything(),
				}),
			}),
		);
		expect(offlineModule.consumeOfflineCashSaleAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({
				posProfile: "Main POS",
				company: "Test Company",
			}),
			"offline-ticket-request-001",
		);
		expect(invoiceService.submitInvoice).not.toHaveBeenCalled();
		expect(onSuccess).toHaveBeenCalledWith(
			expect.objectContaining({
				queued: true,
				client_request_id: "offline-ticket-request-001",
			}),
		);
		expect(onFinishNavigation).toHaveBeenCalledWith(true);
	});

	it("submits gift card redemptions without requiring a gift card payment row", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0007",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0007",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [
				{
					mode_of_payment: "Cash",
					type: "Cash",
					account: "1110 - Cash",
					amount: 0,
				},
			],
			rounded_total: 300,
			grand_total: 300,
		});

		const giftCardRedemptions = ref([
			{
				gift_card_code: "GC-ONLY",
				amount: 300,
				cashier: "cashier@example.com",
			},
		]);

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
				posa_allow_partial_payment: 0,
				payments: [
					{
						mode_of_payment: "Cash",
						type: "Cash",
						account: "1110 - Cash",
						default: 1,
					},
				],
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			giftCardRedemptions,
			diff_payment: ref(0),
		});

		await expect(
			submitInvoice(false, {
				onFinishNavigation: vi.fn(),
			}),
		).resolves.not.toThrow();

		expect(invoiceService.submitInvoice).toHaveBeenCalledWith(
			expect.objectContaining({
				gift_card_redemptions: [
					expect.objectContaining({
						gift_card_code: "GC-ONLY",
						amount: 300,
					}),
				],
			}),
			expect.objectContaining({
				payments: [
					expect.objectContaining({
						mode_of_payment: "Cash",
						amount: 0,
						account: "1110 - Cash",
					}),
				],
			}),
			"Invoice",
			expect.any(Object),
		);
	});

	it("passes cashier PIN transiently and disables automatic outbox replay", async () => {
		const offlineModule = await import("../src/offline/index");
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-SIGNED",
			doctype: "Sales Invoice",
			docstatus: 1,
			posa_cashier: "cashier@example.com",
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-SIGNED",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "Walk In",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			update_stock: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 100, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				customer: "Default Customer",
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await submitInvoice(
			false,
			{
				onFinishNavigation: vi.fn(),
			},
			{
				cashierSignature: {
					cashierPin: "2468",
					modeOfPayment: "Cash",
				},
			},
		);

		expect(invoiceService.submitInvoice).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			"Invoice",
			expect.any(Object),
			"2468",
		);
		expect(offlineModule.persistInvoiceIntentJournal).not.toHaveBeenCalled();
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
	});

	it("releases a cashier-signed sale after an authoritative PIN rejection without enqueueing a replay", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		(invoiceService.submitInvoice as any).mockRejectedValue(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "CASHIER_PIN_REJECTED",
					message: "Invalid cashier PIN.",
					retryable: false,
				},
				requestId: "req-cashier-pin-1",
				serverTime: null,
			}),
		);
		const toastStore = { show: vi.fn() };
		const invoiceDoc = ref<any>({
			name: "ACC-SINV-CASHIER-PIN",
			doctype: "Sales Invoice",
			is_return: 0,
			customer: "Walk In",
			company: "Test Company",
			currency: "USD",
			conversion_rate: 1,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 100, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
		});
		const {
			submitInvoice,
			submissionRecoveryLocked,
			releaseCashierSignedSubmissionRecovery,
		} = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				name: "Main POS",
				company: "Test Company",
				currency: "USD",
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore,
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await expect(
			submitInvoice(false, {}, {
				cashierSignature: { cashierPin: "0000", modeOfPayment: "Cash" },
			}),
		).rejects.toThrow("Invalid cashier PIN.");

		expect(offlineModule.persistInvoiceIntentJournal).not.toHaveBeenCalled();
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(offlineModule.removeInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(submissionRecoveryLocked.value).toBe(false);
		expect(toastStore.show).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Cashier PIN not accepted" }),
		);

		(invoiceService.submitInvoice as any).mockRejectedValue(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "HTTP_ERROR",
					message: "Service Unavailable",
					retryable: true,
				},
				requestId: "req-cashier-pin-ambiguous-1",
				serverTime: null,
			}),
		);
		const ambiguousResult = await submitInvoice(false, {}, {
			cashierSignature: { cashierPin: "2468", modeOfPayment: "Cash" },
		});
		expect(ambiguousResult).toMatchObject({
			confirmationPending: true,
			manualReview: true,
			automaticRecoveryAvailable: false,
		});
		expect(offlineModule.persistInvoiceIntentJournal).not.toHaveBeenCalled();
		expect(offlineModule.enqueueInvoiceOutboxEntry).not.toHaveBeenCalled();
		expect(submissionRecoveryLocked.value).toBe(true);
		expect(releaseCashierSignedSubmissionRecovery()).toBe(true);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(submissionRecoveryLocked.value).toBe(false);
	});

	it("cleans durable intent after authoritative validation and business failures", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		const offlineModule = await import("../src/offline/index");
		(invoiceService.submitInvoice as any).mockRejectedValue(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "VALIDATION_ERROR",
					message: "Customer is required",
					retryable: false,
				},
				requestId: "req-validation-1",
				serverTime: "2026-05-01T06:00:00Z",
			}),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const toastStore = { show: vi.fn() };

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-VALIDATION",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 100, type: "Cash" }],
			rounded_total: 100,
			grand_total: 100,
		});

		const { submitInvoice, submissionRecoveryLocked } =
			usePaymentSubmission({
				invoiceDoc,
				posProfile: ref({
					posa_allow_submissions_in_background_job: 0,
					create_pos_invoice_instead_of_sales_invoice: 0,
				}),
				stockSettings: ref({}),
				invoiceType: ref("Invoice"),
				formatFloat: (value) => Number(value || 0),
				stores: {
					toastStore,
					uiStore: {
						setLastInvoice: vi.fn(),
						setLastStockAdjustment: vi.fn(),
					},
					customersStore: { setSelectedCustomer: vi.fn() },
					invoiceStore: { invoiceDoc: invoiceDoc.value },
				},
				isCashback: ref(false),
				paidChange: ref(0),
				creditChange: ref(0),
				redeemedCustomerCredit: ref(0),
				customerCreditDict: ref([]),
				diff_payment: ref(0),
			});

		await expect(
			submitInvoice(false, {
				onFinishNavigation: vi.fn(),
			}),
		).rejects.toThrow("Customer is required");

		expect(toastStore.show).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Unable to submit invoice",
				detail: expect.stringContaining("req-validation-1"),
				color: "error",
			}),
		);
		expect(consoleError).toHaveBeenCalledWith(
			"Error submitting invoice:",
			expect.objectContaining({
				code: "VALIDATION_ERROR",
				requestId: "req-validation-1",
			}),
		);
		expect(offlineModule.removeInvoiceOutboxEntry).toHaveBeenCalledWith(
			invoiceDoc.value.posa_client_request_id,
			expect.objectContaining({
				invoice: expect.objectContaining({
					name: "ACC-SINV-VALIDATION",
				}),
			}),
			"pending",
		);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(submissionRecoveryLocked.value).toBe(false);

		(invoiceService.submitInvoice as any).mockRejectedValue(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "BUSINESS_RULE",
					message: "Cashier is not authorized for this sale",
					retryable: false,
				},
				requestId: "req-business-1",
				serverTime: "2026-05-01T06:00:01Z",
			}),
		);
		await expect(submitInvoice(false)).rejects.toThrow(
			"Cashier is not authorized for this sale",
		);
		expect(offlineModule.removeInvoiceOutboxEntry).toHaveBeenCalledTimes(2);
		expect(offlineModule.removeInvoiceOutboxEntry).toHaveBeenLastCalledWith(
			invoiceDoc.value.posa_client_request_id,
			expect.objectContaining({
				invoice: expect.objectContaining({
					name: "ACC-SINV-VALIDATION",
				}),
			}),
			"pending",
		);
		expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		expect(submissionRecoveryLocked.value).toBe(false);
		consoleError.mockRestore();
	});

	it("keeps timestamp-conflict recovery locked until immutable request identity is confirmed", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		(invoiceService.submitInvoice as any).mockRejectedValue(
			new ApiEnvelopeError({
				ok: false,
				data: null,
				error: {
					code: "TIMESTAMP_MISMATCH",
					message: "Document was modified after opening",
					retryable: false,
				},
				requestId: "req-timestamp-recovered",
				serverTime: "2026-05-01T06:00:00Z",
			}),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		(globalThis as any).frappe.call = vi
			.fn()
			.mockImplementation(async () => {
				expect(getActiveInvoiceSubmissionRecovery()).toEqual(
					expect.objectContaining({
						invoiceName: "ACC-SINV-TIMESTAMP-RECOVERED",
					}),
				);
				return { message: { docstatus: 1 } };
			});
		const onFinishNavigation = vi.fn();
		const submission = usePaymentSubmission({
			invoiceDoc: ref({
				name: "ACC-SINV-TIMESTAMP-RECOVERED",
				doctype: "Sales Invoice",
				is_return: 0,
				items: [{ item_code: "ITEM-TIMESTAMP", qty: 1 }],
				payments: [
					{ mode_of_payment: "Cash", amount: 30, type: "Cash" },
				],
				rounded_total: 30,
				grand_total: 30,
			}),
			posProfile: ref({ name: "Main POS", company: "Test Company" }),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: { setLastInvoice: vi.fn() },
			},
		});

		try {
			await expect(
				submission.submitInvoice(false, { onFinishNavigation }),
			).resolves.toEqual(
				expect.objectContaining({
					confirmationPending: true,
				}),
			);

			expect(onFinishNavigation).not.toHaveBeenCalled();
			expect(submission.submissionRecoveryLocked.value).toBe(true);
			expect(getActiveInvoiceSubmissionRecovery()).toEqual(
				expect.objectContaining({
					invoiceName: "ACC-SINV-TIMESTAMP-RECOVERED",
				}),
			);
		} finally {
			submission.stopSubmissionRecoveryMonitor();
			consoleError.mockRestore();
		}
	});

	it("normalizes return payment rows before submit even when cashback is disabled", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-RETURN-0001",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-RETURN-0001",
			doctype: "Sales Invoice",
			is_return: 1,
			items: [{ item_code: "ITEM-1", qty: -1 }],
			payments: [
				{
					mode_of_payment: "Cash",
					amount: 90,
					base_amount: 90,
					type: "Cash",
				},
			],
			rounded_total: -90,
			grand_total: -90,
		});

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
			}),
			stockSettings: ref({}),
			invoiceType: ref("Return"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await submitInvoice(false, {
			onFinishNavigation: vi.fn(),
		});

		const [, submittedDoc] = (invoiceService.submitInvoice as any).mock
			.calls[0];
		expect(submittedDoc.payments).toEqual([
			expect.objectContaining({
				mode_of_payment: "Cash",
				amount: -90,
				base_amount: -90,
			}),
		]);
	});

	it("allows cashback validation for returns without an original invoice", async () => {
		const invoiceDoc = ref<any>({
			name: "ACC-SINV-RETURN-WITHOUT-INVOICE",
			doctype: "Sales Invoice",
			is_return: 1,
			items: [{ item_code: "ITEM-1", qty: -1 }],
			payments: [
				{
					mode_of_payment: "Cash",
					amount: -2625,
					base_amount: -2625,
					type: "Cash",
				},
			],
			rounded_total: -2625,
			grand_total: -2625,
			posa_refundable_amount: 0,
		});

		const { validateSubmission } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({}),
			stockSettings: ref({}),
			invoiceType: ref("Return"),
			formatFloat: (value) => Number(value || 0),
			isCashback: ref(true),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await expect(validateSubmission(false)).resolves.toBe(true);
	});

	it("rejects cashback above paid amount for returns against an original invoice", async () => {
		const invoiceDoc = ref<any>({
			name: "ACC-SINV-RETURN-AGAINST-INVOICE",
			doctype: "Sales Invoice",
			is_return: 1,
			return_against: "ACC-SINV-0001",
			items: [{ item_code: "ITEM-1", qty: -1 }],
			payments: [
				{
					mode_of_payment: "Cash",
					amount: -2625,
					base_amount: -2625,
					type: "Cash",
				},
			],
			rounded_total: -2625,
			grand_total: -2625,
			posa_refundable_amount: 0,
		});

		const { validateSubmission } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({}),
			stockSettings: ref({}),
			invoiceType: ref("Return"),
			formatFloat: (value) => Number(value || 0),
			isCashback: ref(true),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			diff_payment: ref(0),
		});

		await expect(validateSubmission(false)).rejects.toThrow(
			"Cannot refund 2625 for this return: only 0 was paid on the original invoice",
		);
	});

	it("allows gift card submission when no gift card mode of payment is configured", async () => {
		const invoiceService = (
			await import("../src/posapp/services/invoiceService")
		).default;
		mockInvoiceSubmissionResponse(invoiceService, {
			name: "ACC-SINV-0008",
			doctype: "Sales Invoice",
			docstatus: 1,
		});

		const invoiceDoc = ref<any>({
			name: "ACC-SINV-0008",
			doctype: "Sales Invoice",
			is_return: 0,
			items: [{ item_code: "ITEM-1", qty: 1 }],
			payments: [{ mode_of_payment: "Cash", amount: 0, type: "Cash" }],
			rounded_total: 300,
			grand_total: 300,
		});

		const giftCardRedemptions = ref([
			{
				gift_card_code: "GC-MISSING",
				amount: 300,
				cashier: "cashier@example.com",
			},
		]);

		const { submitInvoice } = usePaymentSubmission({
			invoiceDoc,
			posProfile: ref({
				posa_allow_submissions_in_background_job: 0,
				create_pos_invoice_instead_of_sales_invoice: 0,
				posa_allow_partial_payment: 0,
				payments: [
					{
						mode_of_payment: "Cash",
						type: "Cash",
						account: "1110 - Cash",
						default: 1,
					},
				],
			}),
			stockSettings: ref({}),
			invoiceType: ref("Invoice"),
			formatFloat: (value) => Number(value || 0),
			stores: {
				toastStore: { show: vi.fn() },
				uiStore: {
					setLastInvoice: vi.fn(),
					setLastStockAdjustment: vi.fn(),
				},
				customersStore: { setSelectedCustomer: vi.fn() },
				invoiceStore: { invoiceDoc: invoiceDoc.value },
			},
			isCashback: ref(false),
			paidChange: ref(0),
			creditChange: ref(0),
			redeemedCustomerCredit: ref(0),
			customerCreditDict: ref([]),
			giftCardRedemptions,
			diff_payment: ref(0),
		});

		await expect(
			submitInvoice(false, {
				onFinishNavigation: vi.fn(),
			}),
		).resolves.not.toThrow();

		expect(invoiceService.submitInvoice).toHaveBeenCalledWith(
			expect.objectContaining({
				gift_card_redemptions: [
					expect.objectContaining({
						gift_card_code: "GC-MISSING",
						amount: 300,
					}),
				],
			}),
			expect.objectContaining({
				payments: [
					expect.objectContaining({
						mode_of_payment: "Cash",
						amount: 0,
					}),
				],
			}),
			"Invoice",
			expect.any(Object),
		);
	});
});
