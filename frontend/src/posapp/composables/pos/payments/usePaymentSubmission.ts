import { computed, ref, unref, type Ref, type ComputedRef } from "vue";
import invoiceService from "../../../services/invoiceService";
import { isApiEnvelopeError, unwrapApiResult } from "../../../services/api";
import {
	enqueueInvoiceOutboxEntry,
	consumeOfflineCashSaleAuthorization,
	finalizeAcknowledgedInvoiceOutboxEntry,
	getOfflineCustomers,
	getInvoiceOutboxRows,
	isOffline,
	persistInvoiceIntentJournal,
	releaseOfflineCashSaleAuthorization,
	removeInvoiceIntentJournalStrict,
	removeInvoiceOutboxEntry,
	updateLocalStock,
	validateStockForOfflineInvoice,
	type OfflineCashSaleAuthorizationTicket,
	type OfflineSaleAuthorizationScope,
} from "../../../../offline/index";
import {
	ensureInvoiceClientRequestId,
	ensureInvoiceSubmissionIdentity,
	generateClientRequestId,
} from "../../../../offline/idempotency";
import stockCoordinator from "../../../utils/stockCoordinator";
import { parseBooleanSetting } from "../../../utils/stock";
import { resolvePosDocumentDoctype } from "../../../utils/posDocumentMode";
import { toCompanyCurrency } from "../../../utils/erpnextCurrency";
import { shouldApplyReturnRefundCap } from "../../../utils/paymentInitialization";
import { findLossRiskItems } from "../../../utils/lossPrevention";
import {
	buildInvoiceRecoveryCartFingerprint,
	claimInvoiceRecoveryClientEffects,
	clearActiveInvoiceSubmissionRecovery,
	clearInvoiceRecoveryClientEffects,
	getActiveInvoiceSubmissionRecovery,
	isSemanticallyEmptyInvoiceRecoveryCart,
	persistActiveInvoiceSubmissionRecovery,
} from "./recoveryState";

declare const frappe: any;
declare const __: (_str: string, _args?: any[]) => string;

export interface PaymentSubmissionOptions {
	invoiceDoc: Ref<any>;
	posProfile: Ref<any>;
	stockSettings: Ref<any>;
	invoiceType: Ref<string>;
	is_write_off_change?: Ref<boolean>;
	formatFloat: (_val: any, _prec?: number) => number;
	currencyPrecision?: Ref<number>;
	isCashback?: Ref<boolean>;
	paidChange?: Ref<number>;
	creditChange?: Ref<number>;
	redeemedCustomerCredit?: Ref<number>;
	customerCreditDict?: Ref<any[]>;
	giftCardRedemptions?: Ref<any[]>;
	diff_payment?: ComputedRef<number>;
	is_credit_sale?: Ref<boolean>;
	loyaltyAmount?: Ref<number>;
	customerInfo?: Ref<any>;
	stores?: {
		toastStore?: any;
		syncStore?: any;
		customersStore?: any;
		uiStore?: any;
		invoiceStore?: any;
	};
}

export interface CashierSignature {
	cashierPin: string;
	modeOfPayment?: string;
	offlineSaleAuthorization?: OfflineCashSaleAuthorizationTicket | null;
}

export interface SubmissionCallbacks {
	onSuccess?: (_message: any) => void;
	onPrint?: (
		_doc: any,
		_options?: {
			name?: string;
			doctype?: string;
			waitForPostSubmitPayments?: boolean;
			waitForInvoiceProcessing?: boolean;
		},
	) => void;
	onFinishNavigation?: (_success: boolean) => void;
	onScheduleBackgroundCheck?: (_payload: {
		name?: string;
		doctype?: string;
		print?: boolean;
		waitForPostSubmitPayments?: boolean;
		waitForInvoiceProcessing?: boolean;
	}) => void;
}

export interface SubmitInvoiceOptions {
	cashierSignature?: CashierSignature | null;
}

export type ManualSubmissionRecoveryOutcome = "submitted" | "not_submitted";

export interface ManualSubmissionRecoveryResolution {
	outcome: ManualSubmissionRecoveryOutcome;
	documentName?: string | null;
	note: string;
	confirmation: string;
}

export type SubmissionRecoveryPhase =
	| "idle"
	| "confirming"
	| "manual_review"
	| "confirmed";

export interface SubmissionRecoveryState {
	phase: SubmissionRecoveryPhase;
	requestId: string | null;
	invoiceName: string | null;
	detail: string | null;
}

const AMBIGUOUS_SUBMISSION_CODES = new Set([
	"ABORTED",
	"TIMEOUT",
	"TRANSPORT_ERROR",
]);

export function isAmbiguousInvoiceSubmissionFailure(error: any) {
	if (error?.posaAmbiguousSubmission === true) {
		return true;
	}
	if (isApiEnvelopeError(error) && !error.envelope.ok) {
		if (error.envelope.error.code === "HTTP_ERROR") {
			// Once the mutation is dispatched, an HTTP status alone cannot prove
			// whether the server committed before the response path failed. Explicit
			// structured validation/business envelopes are normalized to their own
			// definite codes by the API layer; every remaining HTTP_ERROR fails closed.
			return true;
		}
		return AMBIGUOUS_SUBMISSION_CODES.has(error.envelope.error.code);
	}
	if (error?.name === "AbortError" || error?.name === "TimeoutError") {
		return true;
	}
	if (error instanceof TypeError) {
		return true;
	}
	const message = String(error?.message || "").toLowerCase();
	return (
		message.includes("network request failed") ||
		message.includes("failed to fetch") ||
		message.includes("request timed out") ||
		message.includes("request was cancelled")
	);
}

export function usePaymentSubmission(options: PaymentSubmissionOptions) {
	const {
		invoiceDoc,
		posProfile,
		stockSettings,
		invoiceType,
		formatFloat,
		stores,
	} = options;

	const initialDurableRecovery = getActiveInvoiceSubmissionRecovery();
	const submissionRecovery = ref<SubmissionRecoveryState>(
		initialDurableRecovery
			? {
					phase: "confirming",
					requestId: initialDurableRecovery.requestId,
					invoiceName: initialDurableRecovery.invoiceName,
					detail: null,
				}
			: {
					phase: "idle",
					requestId: null,
					invoiceName: null,
					detail: null,
				},
	);
	const submissionRecoveryLocked = computed(() =>
		["confirming", "manual_review"].includes(
			submissionRecovery.value.phase,
		),
	);
	const submissionRecoveryChecking = ref(false);
	let activeRecoveryMode: "invoice_outbox" | "manual_only" =
		initialDurableRecovery?.recoveryMode || "invoice_outbox";
	const recoveryScopeBlocked = ref(false);
	const submissionRecoveryCanCheckStatus = computed(
		() =>
			submissionRecoveryLocked.value &&
			activeRecoveryMode === "invoice_outbox" &&
			!recoveryScopeBlocked.value,
	);
	const submissionRecoveryDocumentType = computed(
		() =>
			String(
				getActiveInvoiceSubmissionRecovery()?.documentType ||
					resolvePosDocumentDoctype({
						invoiceType: unref(invoiceType),
						posProfile: unref(posProfile),
					}),
			).trim() || null,
	);
	const submissionRecoveryCanResolveManually = computed(
		() =>
			submissionRecoveryLocked.value &&
			activeRecoveryMode === "manual_only" &&
			!recoveryScopeBlocked.value &&
				["Sales Order", "Quotation"].includes(
					submissionRecoveryDocumentType.value || "",
				),
	);
	const submissionRecoveryCanReauthorizeCashier = computed(
		() =>
			submissionRecoveryLocked.value &&
				activeRecoveryMode === "manual_only" &&
				["Sales Invoice", "POS Invoice"].includes(
					submissionRecoveryDocumentType.value || "",
				),
	);
	const settledRecoveryRequestIds = new Set<string>();
	let activeRecoveryCallbacks: SubmissionCallbacks = {};
	let activeRecoveryPrint = Boolean(initialDurableRecovery?.printRequested);
	let recoveryMonitorTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryCyclePromise: Promise<any> | null = null;
	let lastRecoveryToastSignature = "";

	const stopSubmissionRecoveryMonitor = () => {
		if (recoveryMonitorTimer) {
			clearTimeout(recoveryMonitorTimer);
			recoveryMonitorTimer = null;
		}
	};

	const resetSubmissionRecovery = () => {
		stopSubmissionRecoveryMonitor();
		const recoveryToClear = submissionRecovery.value;
		if (
			recoveryToClear.requestId &&
			["confirmed", "idle"].includes(recoveryToClear.phase)
		) {
			clearActiveInvoiceSubmissionRecovery(recoveryToClear.requestId);
		}
		submissionRecovery.value = {
			phase: "idle",
			requestId: null,
			invoiceName: null,
			detail: null,
		};
		activeRecoveryCallbacks = {};
		activeRecoveryPrint = false;
		activeRecoveryMode = "invoice_outbox";
		recoveryScopeBlocked.value = false;
		lastRecoveryToastSignature = "";
	};

	const releaseCashierSignedSubmissionRecovery = () => {
		if (!submissionRecoveryCanReauthorizeCashier.value) {
			return false;
		}
		const requestId = String(submissionRecovery.value.requestId || "").trim();
		if (!requestId || !clearActiveInvoiceSubmissionRecovery(requestId)) {
			return false;
		}
		clearInvoiceRecoveryClientEffects(requestId);
		stopSubmissionRecoveryMonitor();
		submissionRecovery.value = {
			phase: "idle",
			requestId: null,
			invoiceName: null,
			detail: null,
		};
		activeRecoveryCallbacks = {};
		activeRecoveryPrint = false;
		activeRecoveryMode = "invoice_outbox";
		recoveryScopeBlocked.value = false;
		lastRecoveryToastSignature = "";
		return true;
	};

	const showRecoveryToast = (
		phase: Exclude<SubmissionRecoveryPhase, "idle">,
		requestId: string,
		detail?: string | null,
	) => {
		const signature = `${requestId}::${phase}::${detail || ""}`;
		if (signature === lastRecoveryToastSignature) {
			return;
		}
		lastRecoveryToastSignature = signature;
		const key = `invoice-confirmation::${requestId}`;
		if (phase === "confirming") {
			stores?.toastStore?.show({
				key,
				title: __("Sale received; confirming status — do not retry"),
				detail: __("Request ID: {0}", [requestId]),
				color: "warning",
				timeout: -1,
				loading: true,
			});
			return;
		}
		if (phase === "manual_review") {
			stores?.toastStore?.show({
				key,
				title: __("Sale needs supervisor status confirmation"),
				detail:
					detail ||
					__(
						"Ask a POS supervisor to check this sale. Request ID: {0}",
						[requestId],
					),
				color: "error",
				timeout: -1,
				loading: false,
			});
			return;
		}
		stores?.toastStore?.show({
			key,
			title: __("Sale confirmed"),
			detail: detail || undefined,
			color: "success",
			loading: false,
		});
	};

	const normalizeScopeValue = (value: unknown) => String(value || "").trim();
	const getLiveCartItems = () => {
		const source = stores?.invoiceStore?.items;
		if (Array.isArray(source)) {
			return source;
		}
		if (Array.isArray(source?.value)) {
			return source.value;
		}
		return Array.isArray(unref(invoiceDoc)?.items)
			? unref(invoiceDoc).items
			: [];
	};

	const getRecoveryCartIdentityStatus = (
		durableRecovery = getActiveInvoiceSubmissionRecovery(),
	) => {
		const requestId = normalizeScopeValue(durableRecovery?.requestId);
		const currentDoc = unref(invoiceDoc) || {};
		const currentItems = getLiveCartItems();
		const currentRequestId = normalizeScopeValue(
			currentDoc?.posa_client_request_id,
		);
		if (!requestId) {
			return {
				safe: false,
				detail: __(
					"The original cart identity is unavailable. Do not retry or clear this sale; ask a supervisor to investigate.",
				),
			};
		}
		if (currentRequestId && currentRequestId !== requestId) {
			return {
				safe: false,
				detail: __(
					"A newer cart is active in this browser. The confirmed sale cannot clear or replace it; ask a supervisor to finish recovery.",
				),
			};
		}
		if (isSemanticallyEmptyInvoiceRecoveryCart(currentDoc, currentItems)) {
			return { safe: true, alreadyEmpty: true, detail: null };
		}
		if (currentRequestId !== requestId) {
			return {
				safe: false,
				detail: __(
					"The active cart cannot be proven to own the submitted request. It was left untouched; ask a supervisor to finish recovery.",
				),
			};
		}

		const expectedFingerprint = normalizeScopeValue(
			durableRecovery?.cartFingerprint,
		);
		const currentFingerprint = buildInvoiceRecoveryCartFingerprint(
			currentDoc,
			currentItems,
		);
		if (expectedFingerprint) {
			if (currentFingerprint === expectedFingerprint) {
				return { safe: true, alreadyEmpty: false, detail: null };
			}
			return {
				safe: false,
				detail: __(
					"The active cart no longer matches the sale that was submitted. It was left untouched; ask a supervisor to finish recovery.",
				),
			};
		}
		if (currentRequestId === requestId) {
			// Backward compatibility for a recovery pointer created before semantic
			// fingerprints existed. Exact request ownership still fails closed against
			// a newer cart, while new pointers always require both checks.
			return { safe: true, alreadyEmpty: false, detail: null };
		}
		return {
			safe: false,
			detail: __(
				"The active cart cannot be proven to be the submitted sale. It was left untouched; ask a supervisor to finish recovery.",
			),
		};
	};

	const lockRecoveryForCartIdentityMismatch = (
		requestId: string,
		invoiceName: string | null,
		detail: string,
	) => {
		stopSubmissionRecoveryMonitor();
		submissionRecovery.value = {
			phase: "manual_review",
			requestId,
			invoiceName,
			detail,
		};
		showRecoveryToast("manual_review", requestId, detail);
	};

	const getRecoveryScopeStatus = (
		durableRecovery = getActiveInvoiceSubmissionRecovery(),
		source: any = {},
	) => {
		const sourceInvoice = source?.invoice || source?.payload?.invoice || {};
		const expected = {
			posProfile: normalizeScopeValue(
				durableRecovery?.posProfile || sourceInvoice?.pos_profile,
			),
			company: normalizeScopeValue(
				durableRecovery?.company || sourceInvoice?.company,
			),
			user: normalizeScopeValue(durableRecovery?.user),
		};
		if (!expected.posProfile || !expected.company || !expected.user) {
			return {
				safe: false,
				waiting: false,
				detail: __(
					"The saved recovery is missing its original POS security scope. Do not retry it; ask a supervisor to investigate.",
				),
			};
		}

		const profile = unref(posProfile) || {};
		const doc = unref(invoiceDoc) || {};
		const current = {
			posProfile: normalizeScopeValue(profile?.name),
			company: normalizeScopeValue(profile?.company),
			user: normalizeScopeValue(
				(globalThis as any)?.frappe?.session?.user,
			),
		};
		if (!current.posProfile || !current.company || !current.user) {
			return {
				safe: false,
				waiting: true,
				detail: __(
					"Waiting for the original POS profile and user context before confirming this sale.",
				),
			};
		}

		const mismatches = (["posProfile", "company", "user"] as const).filter(
			(fieldname) => expected[fieldname] !== current[fieldname],
		);
		const documentScope = {
			posProfile: normalizeScopeValue(doc?.pos_profile),
			company: normalizeScopeValue(doc?.company),
		};
		if (
			(documentScope.posProfile &&
				documentScope.posProfile !== expected.posProfile) ||
			(documentScope.company &&
				documentScope.company !== expected.company)
		) {
			mismatches.push("posProfile");
		}
		if (mismatches.length) {
			return {
				safe: false,
				waiting: false,
				detail: __(
					"This recovery belongs to POS Profile {0}, company {1}, and user {2}. Switch back to that context before resolving it.",
					[expected.posProfile, expected.company, expected.user],
				),
			};
		}
		return { safe: true, waiting: false, detail: null };
	};

	const applyRecoveryScopeGate = (
		durableRecovery = getActiveInvoiceSubmissionRecovery(),
		source: any = {},
	) => {
		const scopeStatus = getRecoveryScopeStatus(durableRecovery, source);
		if (scopeStatus.safe) {
			recoveryScopeBlocked.value = false;
			return scopeStatus;
		}
		const requestId = String(
			submissionRecovery.value.requestId ||
				durableRecovery?.requestId ||
				"",
		).trim();
		stopSubmissionRecoveryMonitor();
		recoveryScopeBlocked.value = !scopeStatus.waiting;
		submissionRecovery.value = {
			phase: scopeStatus.waiting ? "confirming" : "manual_review",
			requestId: requestId || null,
			invoiceName:
				submissionRecovery.value.invoiceName ||
				durableRecovery?.invoiceName ||
				null,
			detail: scopeStatus.detail,
		};
		if (requestId) {
			showRecoveryToast(
				scopeStatus.waiting ? "confirming" : "manual_review",
				requestId,
				scopeStatus.detail,
			);
		}
		return scopeStatus;
	};

	const getRecoveryInvoiceIdentity = (source: any = {}) => {
		const nestedInvoice = source?.invoice || {};
		const rawStatus =
			nestedInvoice?.docstatus ??
			nestedInvoice?.status ??
			source?.docstatus ??
			source?.status ??
			null;
		const numericStatus =
			rawStatus === null || rawStatus === "" ? null : Number(rawStatus);
		return {
			name:
				source?.invoice_name ||
				nestedInvoice?.name ||
				source?.name ||
				submissionRecovery.value.invoiceName ||
				unref(invoiceDoc)?.name ||
				null,
			doctype:
				nestedInvoice?.doctype ||
				source?.doctype ||
				unref(invoiceDoc)?.doctype ||
				resolvePosDocumentDoctype({
					invoiceType: unref(invoiceType),
					posProfile: unref(posProfile),
				}),
			docstatus:
				numericStatus !== null && Number.isFinite(numericStatus)
					? numericStatus
					: null,
		};
	};

	const isExplicitlyAcknowledgedRecovery = (
		source: any,
		requestId: string,
		durableRecovery = getActiveInvoiceSubmissionRecovery(),
	) => {
		const responseRequestId = String(
			source?.client_request_id || "",
		).trim();
		const expectedDoctype = String(
			durableRecovery?.documentType || "",
		).trim();
		if (
			responseRequestId !== requestId ||
			!["Sales Invoice", "POS Invoice"].includes(expectedDoctype)
		) {
			return false;
		}
		if (source?.status === "acknowledged") {
			// This terminal state is written only after invoiceOutbox validates the
			// exact server acknowledgement and persists its submitted invoice name.
			return (
				Boolean(String(source?.invoice_name || "").trim()) &&
				String(source?.invoice?.doctype || "").trim() ===
					expectedDoctype
			);
		}
		const responseInvoice = source?.invoice || {};
		const statusValues = [
			responseInvoice?.docstatus,
			responseInvoice?.status,
		].filter(
			(value) => value !== null && value !== undefined && value !== "",
		);
		return (
			source?.acknowledged === true &&
			Boolean(String(responseInvoice?.name || "").trim()) &&
			String(responseInvoice?.doctype || "").trim() === expectedDoctype &&
			statusValues.length > 0 &&
			statusValues.every((value) => Number(value) === 1)
		);
	};

	const settleRecoveredSubmission = async (source: any = {}) => {
		const durableRecovery = getActiveInvoiceSubmissionRecovery();
		const requestId = String(
			submissionRecovery.value.requestId ||
				durableRecovery?.requestId ||
				"",
		).trim();
		if (!requestId || settledRecoveryRequestIds.has(requestId)) {
			return { confirmed: Boolean(requestId), alreadySettled: true };
		}
		const scopeStatus = applyRecoveryScopeGate(durableRecovery, source);
		if (!scopeStatus.safe) {
			return {
				confirmed: false,
				manualReview: !scopeStatus.waiting,
				waitingForScope: scopeStatus.waiting,
			};
		}

		const identity = getRecoveryInvoiceIdentity(source);
		if (
			!isExplicitlyAcknowledgedRecovery(
				source,
				requestId,
				durableRecovery,
			)
		) {
			return { confirmed: false, acknowledged: false };
		}
		const cartIdentityStatus =
			getRecoveryCartIdentityStatus(durableRecovery);
		if (!cartIdentityStatus.safe) {
			lockRecoveryForCartIdentityMismatch(
				requestId,
				identity.name,
				String(cartIdentityStatus.detail || ""),
			);
			return {
				confirmed: true,
				manualReview: true,
				cartIdentityMismatch: true,
			};
		}

		stopSubmissionRecoveryMonitor();
		const recoveryCallbacks = { ...activeRecoveryCallbacks };
		const shouldPrintRecoveredInvoice = activeRecoveryPrint;
		let shouldApplyClientEffects: boolean;
		try {
			shouldApplyClientEffects =
				claimInvoiceRecoveryClientEffects(requestId);
		} catch (error) {
			console.error(
				"Unable to durably claim recovered invoice client effects",
				error,
			);
			const detail = __(
				"This browser could not save the recovery checkpoint. Do not retry the sale; ask a supervisor to check it again.",
			);
			submissionRecovery.value = {
				phase: "manual_review",
				requestId,
				invoiceName: identity.name,
				detail,
			};
			showRecoveryToast("manual_review", requestId, detail);
			return {
				confirmed: false,
				manualReview: true,
				persistenceFailed: true,
				error,
			};
		}
		const submittedItems = Array.isArray(source?.invoice?.items)
			? source.invoice.items
			: Array.isArray(unref(invoiceDoc)?.items)
				? unref(invoiceDoc).items
				: [];
		const lockRecoveredClientCompletion = (error: unknown) => {
			console.error(
				"Recovered submission client completion could not finish",
				error,
			);
			const detail = __(
				"The server confirmed this sale, but the browser could not safely finish it. Do not retry; ask a supervisor to check it again.",
			);
			submissionRecovery.value = {
				phase: "manual_review",
				requestId,
				invoiceName: identity.name,
				detail,
			};
			showRecoveryToast("manual_review", requestId, detail);
			return {
				confirmed: true,
				manualReview: true,
				clientCompletionFailed: true,
				error,
			};
		};
		const clearRecoveredTender = () => {
			const invoiceStore = stores?.invoiceStore;
			if (typeof invoiceStore?.clear !== "function") {
				throw new Error(
					"The recovered tender could not be cleared from the invoice store",
				);
			}
			invoiceStore.clear();
			invoiceStore.resetPostingDate?.();
		};
		const finishRecoveredCheckpoint = () => {
			removeInvoiceIntentJournalStrict(requestId);
			const pointerCleared =
				clearActiveInvoiceSubmissionRecovery(requestId);
			if (!pointerCleared) {
				return false;
			}
			clearInvoiceRecoveryClientEffects(requestId);
			settledRecoveryRequestIds.add(requestId);
			return true;
		};
		const markRecoveredSubmissionConfirmed = () => {
			submissionRecovery.value = {
				phase: "confirmed",
				requestId,
				invoiceName: identity.name,
				detail: null,
			};
		};
		const finishRecoveredNavigation = () => {
			try {
				recoveryCallbacks.onFinishNavigation?.(true);
				return null;
			} catch (error) {
				console.error(
					"Recovered submission navigation could not finish",
					error,
				);
				return error;
			}
		};
		if (!shouldApplyClientEffects) {
			try {
				stores?.invoiceStore?.mergeInvoiceDoc?.({
					name: identity.name,
					doctype: identity.doctype,
					docstatus: 1,
				});
				if (identity.name) {
					stores?.uiStore?.setLastInvoice?.(identity.name);
				}
				// A previous component claimed the irreversible effects but may have
				// crashed before clearing the tender. Clear it while the durable lock
				// still owns the UI, then release the recovery checkpoint.
				clearRecoveredTender();
			} catch (error) {
				return lockRecoveredClientCompletion(error);
			}
			try {
				if (!finishRecoveredCheckpoint()) {
					throw new Error(
						"Unable to clear the active recovery pointer",
					);
				}
			} catch (error) {
				return lockRecoveredClientCompletion(error);
			}
			markRecoveredSubmissionConfirmed();
			const navigationError = finishRecoveredNavigation();
			if (navigationError) {
				return {
					confirmed: true,
					clientCompletionFailed: true,
					error: navigationError,
				};
			}
			return {
				confirmed: true,
				alreadySettled: true,
				clientEffectsApplied: false,
				message: identity,
			};
		}
		try {
			stores?.invoiceStore?.mergeInvoiceDoc?.({
				name: identity.name,
				doctype: identity.doctype,
				docstatus: 1,
			});
			if (identity.name) {
				stores?.uiStore?.setLastInvoice?.(identity.name);
			}

			if (shouldPrintRecoveredInvoice && recoveryCallbacks.onPrint) {
				recoveryCallbacks.onPrint(
					{
						...unref(invoiceDoc),
						...identity,
						docstatus: 1,
					},
					{
						name: identity.name || undefined,
						doctype: identity.doctype,
						waitForPostSubmitPayments: false,
						waitForInvoiceProcessing: false,
					},
				);
			}

			if (frappe?.utils?.play_sound) {
				frappe.utils.play_sound("submit");
			}
			updateLocalStock(submittedItems);
			stockCoordinator.applyInvoiceConsumption(submittedItems, {
				source: "invoice",
			});
			stores?.uiStore?.setLastStockAdjustment?.({
				items: submittedItems,
				item_codes: submittedItems
					.map((item: any) => item?.item_code)
					.filter(
						(itemCode: any) =>
							itemCode !== undefined && itemCode !== null,
					),
				timestamp: Date.now(),
			});
			stores?.customersStore?.setSelectedCustomer?.(
				unref(posProfile)?.customer || null,
			);
			recoveryCallbacks.onSuccess?.({
				...identity,
				docstatus: 1,
				recovered: true,
				client_request_id: requestId,
			});
			clearRecoveredTender();
		} catch (error) {
			return lockRecoveredClientCompletion(error);
		}

		try {
			if (!finishRecoveredCheckpoint()) {
				throw new Error("Unable to clear the active recovery pointer");
			}
		} catch (error) {
			return lockRecoveredClientCompletion(error);
		}
		markRecoveredSubmissionConfirmed();
		showRecoveryToast(
			"confirmed",
			requestId,
			identity.name
				? __("Invoice {0} is submitted.", [identity.name])
				: undefined,
		);
		const navigationError = finishRecoveredNavigation();
		if (navigationError) {
			return {
				confirmed: true,
				clientEffectsApplied: true,
				clientCompletionFailed: true,
				error: navigationError,
			};
		}
		return {
			confirmed: true,
			clientEffectsApplied: true,
			message: identity,
		};
	};

	const markSubmissionForManualReview = (row: any = {}) => {
		const requestId = String(
			submissionRecovery.value.requestId || row?.client_request_id || "",
		).trim();
		if (!requestId) {
			return;
		}
		stopSubmissionRecoveryMonitor();
		const detail = row?.last_error
			? __("Automatic confirmation stopped: {0}", [row.last_error])
			: __("Ask a POS supervisor to check this sale. Request ID: {0}", [
					requestId,
				]);
		submissionRecovery.value = {
			phase: "manual_review",
			requestId,
			invoiceName: row?.invoice_name || unref(invoiceDoc)?.name || null,
			detail,
		};
		showRecoveryToast("manual_review", requestId, detail);
	};

	const refreshSubmissionRecoveryStatus = async () => {
		const requestId = String(
			submissionRecovery.value.requestId || "",
		).trim();
		if (!requestId) {
			return null;
		}

		const rows = await getInvoiceOutboxRows({ includeTerminal: true });
		const row = rows.find(
			(candidate: any) => candidate?.client_request_id === requestId,
		);
		if (!row) {
			return null;
		}
		if (row.status === "acknowledged") {
			await settleRecoveredSubmission(row);
			return row;
		}
		if (row.status === "dead_letter") {
			markSubmissionForManualReview(row);
			return row;
		}

		submissionRecovery.value = {
			...submissionRecovery.value,
			phase: "confirming",
			invoiceName:
				row.invoice_name ||
				submissionRecovery.value.invoiceName ||
				null,
			detail: null,
		};
		return row;
	};

	const getRecoveryRetryDelay = (row: any) => {
		if (row?.next_retry_at) {
			const dueAt = Date.parse(row.next_retry_at);
			if (Number.isFinite(dueAt) && dueAt > Date.now()) {
				return Math.min(5 * 60 * 1_000, dueAt - Date.now() + 100);
			}
		}
		return row?.status === "syncing" ? 1_000 : 2_000;
	};

	const scheduleSubmissionRecoveryCheck = (delay: number) => {
		stopSubmissionRecoveryMonitor();
		if (submissionRecovery.value.phase !== "confirming") {
			return;
		}
		recoveryMonitorTimer = setTimeout(
			() => {
				recoveryMonitorTimer = null;
				void runSubmissionRecoveryCycle();
			},
			Math.max(250, delay),
		);
	};

	const runSubmissionRecoveryCycle = async () => {
		if (recoveryCyclePromise) {
			return recoveryCyclePromise;
		}
		if (submissionRecovery.value.phase !== "confirming") {
			return null;
		}

		recoveryCyclePromise = (async () => {
			submissionRecoveryChecking.value = true;
			try {
				await stores?.syncStore?.syncPendingInvoices?.({
					showToasts: false,
					transactionalOnly: true,
				});
				const row = await refreshSubmissionRecoveryStatus();
				if (submissionRecovery.value.phase === "confirming") {
					scheduleSubmissionRecoveryCheck(getRecoveryRetryDelay(row));
				}
				return row;
			} catch (error) {
				console.warn(
					"Unable to confirm pending invoice submission",
					error,
				);
				if (submissionRecovery.value.phase === "confirming") {
					scheduleSubmissionRecoveryCheck(2_000);
				}
				return null;
			} finally {
				submissionRecoveryChecking.value = false;
			}
		})().finally(() => {
			recoveryCyclePromise = null;
		});
		return recoveryCyclePromise;
	};

	const beginSubmissionRecovery = (
		requestId: string,
		callbacks: SubmissionCallbacks,
	) => {
		const normalizedRequestId = String(requestId || "").trim();
		if (!normalizedRequestId) {
			throw new Error("Invoice recovery requires a client request ID");
		}
		const durableRecovery = getActiveInvoiceSubmissionRecovery();
		activeRecoveryCallbacks = { ...callbacks };
		activeRecoveryPrint = Boolean(durableRecovery?.printRequested);
		activeRecoveryMode = durableRecovery?.recoveryMode || "invoice_outbox";
		submissionRecovery.value = {
			phase: "confirming",
			requestId: normalizedRequestId,
			invoiceName: unref(invoiceDoc)?.name || null,
			detail: null,
		};
		if (durableRecovery?.requestId !== normalizedRequestId) {
			console.error(
				"Ambiguous invoice submission has no matching durable recovery lock",
			);
			const detail = __(
				"The sale outcome is unknown and its browser recovery lock is unavailable. Do not retry the sale; ask a supervisor to check it.",
			);
			markSubmissionForManualReview({
				client_request_id: normalizedRequestId,
				invoice_name: unref(invoiceDoc)?.name || null,
				last_error: detail,
			});
			return {
				confirmationPending: true,
				manualReview: true,
				recoveryPointerMissing: true,
				requestId: normalizedRequestId,
			};
		}
		if (activeRecoveryMode === "manual_only") {
			const detail = __(
				"Automatic recovery is not available for this document type. Do not retry it; ask a supervisor to verify it in the back office.",
			);
			submissionRecovery.value = {
				...submissionRecovery.value,
				phase: "manual_review",
				detail,
			};
			showRecoveryToast("manual_review", normalizedRequestId, detail);
			return {
				confirmationPending: true,
				manualReview: true,
				automaticRecoveryAvailable: false,
				requestId: normalizedRequestId,
			};
		}
		showRecoveryToast("confirming", normalizedRequestId);
		void runSubmissionRecoveryCycle();
		return {
			confirmationPending: true,
			requestId: normalizedRequestId,
		};
	};

	const resumePendingSubmissionRecovery = async (
		callbacks: SubmissionCallbacks = {},
	) => {
		const durableRecovery = getActiveInvoiceSubmissionRecovery();
		const requestId = String(
			durableRecovery?.requestId ||
				unref(invoiceDoc)?.posa_client_request_id ||
				"",
		).trim();
		if (!requestId || settledRecoveryRequestIds.has(requestId)) {
			return null;
		}
		if (durableRecovery) {
			activeRecoveryCallbacks = { ...callbacks };
			activeRecoveryPrint = Boolean(durableRecovery.printRequested);
			activeRecoveryMode = durableRecovery.recoveryMode;
			// Lock synchronously before IndexedDB access. A slow or unavailable
			// outbox must never leave a crash-restored tender resubmittable.
			submissionRecovery.value = {
				phase: "confirming",
				requestId,
				invoiceName:
					durableRecovery.invoiceName ||
					unref(invoiceDoc)?.name ||
					null,
				detail: null,
			};
			const scopeStatus = applyRecoveryScopeGate(durableRecovery);
			if (!scopeStatus.safe) {
				return {
					...submissionRecovery.value,
					manualReview: !scopeStatus.waiting,
					waitingForScope: scopeStatus.waiting,
					scopeBlocked: !scopeStatus.waiting,
				};
			}
			if (activeRecoveryMode === "manual_only") {
				const detail = __(
					"Automatic recovery is not available for this document type. Do not retry it; ask a supervisor to verify it in the back office.",
				);
				submissionRecovery.value = {
					...submissionRecovery.value,
					phase: "manual_review",
					detail,
				};
				showRecoveryToast("manual_review", requestId, detail);
				return {
					...submissionRecovery.value,
					automaticRecoveryAvailable: false,
				};
			}
		}
		let rows: any[];
		try {
			rows = await getInvoiceOutboxRows({ includeTerminal: true });
		} catch (error: any) {
			if (!durableRecovery) {
				console.warn("Unable to read invoice recovery outbox", error);
				return null;
			}
			const detail = __(
				"The saved sale recovery could not be read. Do not retry the sale; ask a supervisor to check its status.",
			);
			submissionRecovery.value = {
				...submissionRecovery.value,
				phase: "manual_review",
				detail,
			};
			showRecoveryToast("manual_review", requestId, detail);
			return {
				...submissionRecovery.value,
				outboxReadFailed: true,
				error,
			};
		}
		const row = rows.find(
			(candidate: any) => candidate?.client_request_id === requestId,
		);
		if (!row && !durableRecovery) {
			return null;
		}
		activeRecoveryCallbacks = { ...callbacks };
		activeRecoveryPrint = Boolean(durableRecovery?.printRequested);
		activeRecoveryMode = "invoice_outbox";
		if (!durableRecovery) {
			const adoptedScope = {
				posProfile: normalizeScopeValue(row?.invoice?.pos_profile),
				company: normalizeScopeValue(row?.invoice?.company),
				user: normalizeScopeValue(
					(globalThis as any)?.frappe?.session?.user,
				),
			};
			const scopeStatus = applyRecoveryScopeGate(
				{
					requestId,
					invoiceName:
						row?.invoice_name || unref(invoiceDoc)?.name || null,
					documentType: row?.invoice?.doctype || null,
					recoveryMode: "invoice_outbox",
					cartFingerprint: null,
					printRequested: false,
					startedAt: new Date().toISOString(),
					...adoptedScope,
				},
				row,
			);
			if (!scopeStatus.safe) {
				return {
					...submissionRecovery.value,
					manualReview: !scopeStatus.waiting,
					waitingForScope: scopeStatus.waiting,
					scopeBlocked: !scopeStatus.waiting,
				};
			}
			try {
				persistActiveInvoiceSubmissionRecovery({
					requestId,
					invoiceName:
						row?.invoice_name || unref(invoiceDoc)?.name || null,
					documentType:
						row?.invoice?.doctype ||
						unref(invoiceDoc)?.doctype ||
						resolvePosDocumentDoctype({
							invoiceType: unref(invoiceType),
							posProfile: unref(posProfile),
						}),
					recoveryMode: "invoice_outbox",
					posProfile: adoptedScope.posProfile,
					company: adoptedScope.company,
					user: adoptedScope.user,
					cartFingerprint: buildInvoiceRecoveryCartFingerprint(
						row?.invoice || unref(invoiceDoc) || {},
						row?.invoice?.items || getLiveCartItems(),
					),
					printRequested: false,
				});
			} catch (error) {
				console.error(
					"Unable to persist restored invoice recovery lock",
					error,
				);
				submissionRecovery.value = {
					phase: "manual_review",
					requestId,
					invoiceName:
						row?.invoice_name || unref(invoiceDoc)?.name || null,
					detail: null,
				};
				const detail = __(
					"This browser could not save the recovery lock. Do not retry the sale; ask a supervisor to check it.",
				);
				markSubmissionForManualReview({
					client_request_id: requestId,
					invoice_name:
						row?.invoice_name || unref(invoiceDoc)?.name || null,
					last_error: detail,
				});
				return submissionRecovery.value;
			}
		}
		submissionRecovery.value = {
			phase:
				row?.status === "dead_letter" ? "manual_review" : "confirming",
			requestId,
			invoiceName:
				row?.invoice_name ||
				durableRecovery?.invoiceName ||
				unref(invoiceDoc)?.name ||
				null,
			detail: row?.last_error || null,
		};
		if (row?.status === "acknowledged") {
			return await settleRecoveredSubmission(row);
		}
		if (row?.status === "dead_letter") {
			markSubmissionForManualReview(row);
		} else {
			showRecoveryToast("confirming", requestId);
			void runSubmissionRecoveryCycle();
		}
		return submissionRecovery.value;
	};

	const manuallyReconcilePendingSubmission = async () => {
		const requestId = String(
			submissionRecovery.value.requestId || "",
		).trim();
		if (!requestId) {
			return { confirmed: false };
		}
		if (activeRecoveryMode === "manual_only") {
			return {
				confirmed: false,
				manualReview: true,
				automaticRecoveryAvailable: false,
			};
		}
		if (settledRecoveryRequestIds.has(requestId)) {
			return { confirmed: true, alreadySettled: true };
		}

		stopSubmissionRecoveryMonitor();
		submissionRecoveryChecking.value = true;
		try {
			const profile = unref(posProfile) || {};
			const doc = unref(invoiceDoc) || {};
			const result = await frappe.call({
				method: "posawesome.posawesome.api.offline_sync.invoices.reconcile_invoice_outbox_entry",
				args: {
					client_request_id: requestId,
					company: doc.company || profile.company,
					pos_profile: doc.pos_profile || profile.name,
					document_type: resolvePosDocumentDoctype({
						invoiceType: unref(invoiceType),
						posProfile: profile,
					}),
				},
			});
			const response = result?.message || result || {};
			const identity = getRecoveryInvoiceIdentity(response);
			if (
				response?.acknowledged === true ||
				identity.docstatus === 1 ||
				Number(response?.status) === 1
			) {
				return await settleRecoveredSubmission(response);
			}
			markSubmissionForManualReview({
				client_request_id: requestId,
				invoice_name: identity.name,
				last_error: __("The server has not confirmed this sale yet."),
			});
			return { confirmed: false };
		} catch (error: any) {
			const detail =
				error?.message ||
				__(
					"A supervisor could not confirm this sale. Try the status check again.",
				);
			submissionRecovery.value = {
				...submissionRecovery.value,
				phase: "manual_review",
				detail,
			};
			showRecoveryToast("manual_review", requestId, detail);
			return { confirmed: false, error };
		} finally {
			submissionRecoveryChecking.value = false;
		}
	};

	const resolveManualOnlySubmissionRecovery = async (
		resolution: ManualSubmissionRecoveryResolution,
	) => {
		const requestId = String(
			submissionRecovery.value.requestId || "",
		).trim();
		const documentType = submissionRecoveryDocumentType.value;
		const outcome = String(resolution?.outcome || "").trim();
		const documentName = String(
			resolution?.documentName ||
				submissionRecovery.value.invoiceName ||
				"",
		).trim();
		const note = String(resolution?.note || "").trim();
		const confirmation = String(resolution?.confirmation || "").trim();

		if (
			!requestId ||
			!submissionRecoveryCanResolveManually.value ||
			!documentType
		) {
			return {
				resolved: false,
				manualReview: true,
				automaticRecoveryAvailable: false,
			};
		}
		if (!(["submitted", "not_submitted"] as string[]).includes(outcome)) {
			throw new Error("A verified manual recovery outcome is required");
		}
		if (!note) {
			throw new Error("A supervisor recovery note is required");
		}
		if (confirmation !== requestId) {
			throw new Error(
				"The recovery request ID confirmation does not match",
			);
		}
		if (outcome === "submitted" && !documentName) {
			throw new Error("The submitted document name is required");
		}

		stopSubmissionRecoveryMonitor();
		submissionRecoveryChecking.value = true;
		let auditAcknowledged = false;
		try {
			const profile = unref(posProfile) || {};
			const doc = unref(invoiceDoc) || {};
			const result = await frappe.call({
				method: "posawesome.posawesome.api.manual_submission_recovery.resolve_manual_submission_recovery",
				args: {
					client_request_id: requestId,
					pos_profile: doc.pos_profile || profile.name,
					company: doc.company || profile.company,
					document_type: documentType,
					document_name: documentName || null,
					outcome,
					note,
					confirmation,
				},
			});
			const response = result?.message || result || {};
			const responseDocumentName = String(
				response?.document_name || "",
			).trim();
			if (
				response?.resolved !== true ||
				String(response?.client_request_id || "").trim() !==
					requestId ||
				String(response?.document_type || "").trim() !== documentType ||
				String(response?.outcome || "").trim() !== outcome ||
				responseDocumentName !== documentName ||
				!String(response?.audit_name || "").trim()
			) {
				throw new Error(
					"The supervisor recovery audit response did not match this locked sale",
				);
			}
			auditAcknowledged = true;
			const cartIdentityStatus = getRecoveryCartIdentityStatus(
				getActiveInvoiceSubmissionRecovery(),
			);
			if (
				!cartIdentityStatus.safe ||
				(outcome === "not_submitted" && cartIdentityStatus.alreadyEmpty)
			) {
				const detail = cartIdentityStatus.safe
					? __(
							"The original cart is no longer available to retain for a controlled retry. The audited decision remains locked for supervisor review.",
						)
					: cartIdentityStatus.detail;
				lockRecoveryForCartIdentityMismatch(
					requestId,
					responseDocumentName || documentName || null,
					String(detail || ""),
				);
				return {
					resolved: false,
					manualReview: true,
					auditAcknowledged: true,
					cartIdentityMismatch: true,
				};
			}

			const recoveryCallbacks = { ...activeRecoveryCallbacks };
			let nextRequestId: string | null = null;
			if (outcome === "submitted") {
				// Clear the tender while the durable lock still exists. If any local
				// cleanup fails, a reload restores the lock and prevents a duplicate.
				stores?.invoiceStore?.mergeInvoiceDoc?.({
					name: responseDocumentName,
					doctype: documentType,
					docstatus: 1,
				});
				stores?.invoiceStore?.clear?.();
				stores?.invoiceStore?.resetPostingDate?.();
			} else {
				nextRequestId = generateClientRequestId("inv");
			}

			if (!clearActiveInvoiceSubmissionRecovery(requestId)) {
				throw new Error(
					"Unable to clear the audited manual recovery lock",
				);
			}
			if (outcome === "not_submitted") {
				const currentDoc = unref(invoiceDoc);
				if (currentDoc && typeof currentDoc === "object") {
					currentDoc.posa_client_request_id = nextRequestId;
				}
			}
			clearInvoiceRecoveryClientEffects(requestId);
			settledRecoveryRequestIds.add(requestId);
			activeRecoveryCallbacks = {};
			activeRecoveryPrint = false;
			activeRecoveryMode = "invoice_outbox";

			if (outcome === "submitted") {
				submissionRecovery.value = {
					phase: "confirmed",
					requestId,
					invoiceName: responseDocumentName,
					detail: null,
				};
				showRecoveryToast(
					"confirmed",
					requestId,
					__("Supervisor verified submitted {0} {1}.", [
						documentType,
						responseDocumentName,
					]),
				);
				try {
					recoveryCallbacks.onFinishNavigation?.(true);
				} catch (navigationError) {
					console.error(
						"Verified manual recovery could not finish navigation",
						navigationError,
					);
					return {
						resolved: true,
						outcome,
						auditName: response.audit_name,
						clientCompletionFailed: true,
						error: navigationError,
					};
				}
			} else {
				submissionRecovery.value = {
					phase: "idle",
					requestId: null,
					invoiceName: null,
					detail: null,
				};
				lastRecoveryToastSignature = "";
				stores?.toastStore?.show({
					title: __(
						"Supervisor verified the document was not created",
					),
					detail: __(
						"The cart is retained with a new retry identity.",
					),
					color: "success",
				});
			}

			return {
				resolved: true,
				outcome,
				auditName: response.audit_name,
				documentName: responseDocumentName || null,
				nextRequestId,
				cartRetained: outcome === "not_submitted",
			};
		} catch (error: any) {
			const detail = auditAcknowledged
				? __(
						"The supervisor decision was audited, but this browser could not safely release the lock. Reload and resolve it again.",
					)
				: error?.message ||
					__(
						"The supervisor outcome could not be audited. The sale remains locked.",
					);
			submissionRecovery.value = {
				...submissionRecovery.value,
				phase: "manual_review",
				detail,
			};
			showRecoveryToast("manual_review", requestId, detail);
			return {
				resolved: false,
				manualReview: true,
				auditAcknowledged,
				error,
			};
		} finally {
			submissionRecoveryChecking.value = false;
		}
	};

	const currencyContext = (doc = unref(invoiceDoc)) => ({
		...(doc || {}),
		pos_profile: unref(posProfile),
	});

	const formatStockErrors = (errors: any[]) => {
		const settings = unref(stockSettings) || {};
		const profile = unref(posProfile) || {};
		const type = unref(invoiceType);

		// Logic for blocking sale
		let blockSaleBeyondAvailableQty = false;
		if (!["Order", "Quotation"].includes(type)) {
			const val = profile.posa_block_sale_beyond_available_qty;
			blockSaleBeyondAvailableQty =
				val === true ||
				val === "true" ||
				val === 1 ||
				val === "1" ||
				val === "Yes";
		}

		const msg = errors
			.map(
				(e) =>
					`${e.item_code} (${e.warehouse}) - ${formatFloat(e.available_qty)}`,
			)
			.join("\n");

		const blocking =
			!settings.allow_negative_stock || blockSaleBeyondAvailableQty;

		return blocking
			? __("Insufficient stock:\n{0}", [msg])
			: __("Stock is lower than requested:\n{0}", [msg]);
	};

	const formatStockIssueLines = (issues: any[]) =>
		issues
			.map(
				(issue) =>
					`${issue.item_code} (${issue.warehouse || __("Unknown Warehouse")}) - ${formatFloat(issue.available_qty)} / ${formatFloat(issue.requested_qty)} requested`,
			)
			.join("\n");

	const shouldValidateStockForSubmission = (doc: any, type: string) => {
		if (!doc || doc.is_return) {
			return false;
		}

		const doctype = String(doc.doctype || "").trim();
		if (
			["Order", "Quotation"].includes(type) ||
			["Sales Order", "Quotation", "Purchase Order"].includes(doctype)
		) {
			return false;
		}

		if (doctype === "Sales Invoice") {
			return parseBooleanSetting(doc.update_stock);
		}

		return true;
	};

	const isCashierSignedInvoiceSubmission = (profile: any, type: string) => {
		const doctype = resolvePosDocumentDoctype({
			invoiceType: type,
			posProfile: profile,
		});
		return doctype === "Sales Invoice" || doctype === "POS Invoice";
	};

	const validateStockBeforeOnlineSubmission = async (
		doc: any,
		profile: any,
		type: string,
	) => {
		if (!shouldValidateStockForSubmission(doc, type)) {
			return;
		}

		const response = await frappe.call({
			method: "posawesome.posawesome.api.invoices.validate_cart_items",
			args: {
				items: JSON.stringify(doc.items || []),
				pos_profile: profile?.name,
			},
		});
		const payload = response?.message;
		const blockingErrors = Array.isArray(payload)
			? payload
			: Array.isArray(payload?.errors)
				? payload.errors
				: [];
		const warnings = Array.isArray(payload?.warnings)
			? payload.warnings
			: [];

		if (blockingErrors.length) {
			throw new Error(formatStockErrors(blockingErrors));
		}

		if (warnings.length) {
			stores?.toastStore?.show({
				title: __("Stock is lower than requested"),
				detail: formatStockIssueLines(warnings),
				color: "warning",
			});
		}
	};

	const extractSubmissionErrorMessage = (exc: any): string => {
		if (!exc) {
			return __("Unknown error");
		}
		if (isApiEnvelopeError(exc)) {
			return exc.envelope.ok
				? __("Unknown error")
				: exc.envelope.error.message || __("Unknown error");
		}
		if (exc?._server_messages) {
			try {
				const parsed = JSON.parse(exc._server_messages);
				if (Array.isArray(parsed) && parsed.length) {
					const first = parsed[0];
					// Check if message is a JSON string containing errors (stock validation)
					try {
						const msgObj = JSON.parse(first);
						if (msgObj.errors && Array.isArray(msgObj.errors)) {
							return formatStockErrors(msgObj.errors);
						}
					} catch {
						/* Not a JSON string */
					}

					if (typeof first === "string") {
						return frappe?.utils?.strip_html
							? frappe.utils.strip_html(first)
							: first;
					}
				}
			} catch {
				/* ignore parse issues */
			}
		}
		if (exc?.message) {
			try {
				const parsed = JSON.parse(exc.message);
				if (parsed.errors && Array.isArray(parsed.errors)) {
					return formatStockErrors(parsed.errors);
				}
			} catch {
				/* Not a JSON string */
			}
			return exc.message;
		}
		return exc.toString ? exc.toString() : __("Unknown error");
	};

	const getSubmissionErrorCode = (exc: any): string | null => {
		if (!isApiEnvelopeError(exc) || exc.envelope.ok) {
			return null;
		}
		return exc.envelope.error.code || null;
	};

	const buildSubmissionFailureToast = (exc: any, message: string) => {
		const code = getSubmissionErrorCode(exc);
		const requestId = isApiEnvelopeError(exc) ? exc.requestId : null;
		const detail = requestId
			? __("Request ID: {0}", [requestId])
			: undefined;
		if (exc?.posaRecoveryPersistenceFailed) {
			return {
				title: __("Sale not sent"),
				detail: message,
				color: "error",
			};
		}

		if (
			code === "TIMEOUT" ||
			code === "HTTP_ERROR" ||
			code === "TRANSPORT_ERROR"
		) {
			return {
				title: __("Connection problem while submitting invoice"),
				detail: detail ? `${message}\n${detail}` : message,
				color: "error",
			};
		}

		if (code === "VALIDATION_ERROR" || code === "BUSINESS_RULE") {
			return {
				title: __("Unable to submit invoice"),
				detail: detail ? `${message}\n${detail}` : message,
				color: "error",
			};
		}

		if (code === "CASHIER_PIN_REJECTED") {
			return {
				title: __("Cashier PIN not accepted"),
				detail: message,
				color: "error",
			};
		}

		return {
			title: __("Error submitting invoice: ") + message,
			detail,
			color: "error",
		};
	};

	const fetchSubmittedDocstatus = async (
		doc: any,
	): Promise<number | null> => {
		const doctype =
			doc?.doctype ||
			(unref(posProfile)?.create_pos_invoice_instead_of_sales_invoice
				? "POS Invoice"
				: "Sales Invoice");
		const name = doc?.name;
		if (!doctype || !name) {
			return null;
		}

		try {
			const result = await frappe.call({
				method: "frappe.client.get_value",
				args: {
					doctype,
					filters: { name },
					fieldname: ["docstatus"],
				},
			});
			const status = result?.message?.docstatus;
			return Number.isFinite(Number(status)) ? Number(status) : null;
		} catch (error) {
			console.warn(
				"Unable to verify submitted docstatus after conflict",
				error,
			);
			return null;
		}
	};

	const getWriteOffLimit = (profile: any): number | null => {
		if (!profile) return null;
		const possibleLimitFields = [
			"write_off_limit",
			"posa_max_write_off_amount",
			"max_write_off_amount",
			"write_off_amount",
			"posa_write_off_limit",
		];

		for (const field of possibleLimitFields) {
			const rawValue = profile?.[field];
			if (
				rawValue === undefined ||
				rawValue === null ||
				rawValue === ""
			) {
				continue;
			}
			const parsed = formatFloat(rawValue);
			if (parsed > 0) {
				return parsed;
			}
		}

		return null;
	};

	const getEffectiveWriteOffAmount = (
		doc: any,
		profile: any,
		diffAmount: number,
	): number => {
		if (!doc || doc.is_return || !unref(options.is_write_off_change)) {
			return 0;
		}

		const outstanding = Math.max(formatFloat(diffAmount), 0);
		if (outstanding <= 0) {
			return 0;
		}

		const requestedWriteOff = Math.max(
			formatFloat(doc?.write_off_amount || 0),
			0,
		);

		const writeOffLimit = getWriteOffLimit(profile);
		if (writeOffLimit === null) {
			return formatFloat(
				requestedWriteOff > 0
					? Math.min(requestedWriteOff, outstanding)
					: outstanding,
			);
		}

		const cappedByLimit = Math.min(outstanding, writeOffLimit);
		if (requestedWriteOff > 0) {
			return formatFloat(Math.min(requestedWriteOff, cappedByLimit));
		}

		return formatFloat(cappedByLimit);
	};

	const validateDueDate = () => {
		const doc = unref(invoiceDoc);
		if (!doc || !doc.due_date) return;

		const today = frappe?.datetime?.now_date?.();
		if (!today) return;

		const new_date = Date.parse(doc.due_date);
		const parse_today = Date.parse(today);
		if (new_date < parse_today) {
			doc.due_date = today;
		}
	};

	const getLoyaltyRedemptionForSubmission = (doc: any) => {
		const prec = unref(options.currencyPrecision) || 2;
		const hasExplicitLoyaltyAmount = Object.prototype.hasOwnProperty.call(
			options,
			"loyaltyAmount",
		);
		const requestedAmount = formatFloat(
			hasExplicitLoyaltyAmount ? unref(options.loyaltyAmount) : 0,
			prec,
		);
		const docAmount = formatFloat(doc?.loyalty_amount || 0, prec);
		const loyaltyAmount = hasExplicitLoyaltyAmount
			? requestedAmount
			: docAmount;
		if (loyaltyAmount <= 0) {
			return { amount: 0, points: 0 };
		}

		const existingPoints = Math.trunc(
			formatFloat(doc?.loyalty_points || 0, prec),
		);
		const explicitAmountMatchesDoc =
			Math.abs(requestedAmount - docAmount) < 1 / 10 ** prec;
		if (
			existingPoints > 0 &&
			(!hasExplicitLoyaltyAmount || explicitAmountMatchesDoc)
		) {
			return { amount: loyaltyAmount, points: existingPoints };
		}

		const info = unref(options.customerInfo) || {};
		const conversionFactor = Number(info.conversion_factor || 0);
		if (conversionFactor <= 0) {
			return { amount: 0, points: 0 };
		}

		const baseAmount = toCompanyCurrency(
			currencyContext(doc),
			loyaltyAmount,
		);
		const loyaltyPoints = Math.trunc(baseAmount / conversionFactor);
		if (loyaltyPoints <= 0) {
			return { amount: 0, points: 0 };
		}

		return { amount: loyaltyAmount, points: loyaltyPoints };
	};

	const validateSubmission = async (payment_received = false) => {
		const doc = unref(invoiceDoc);
		const profile = unref(posProfile);
		const prec = unref(options.currencyPrecision) || 2;
		const {
			isCashback,
			paidChange,
			creditChange,
			redeemedCustomerCredit,
			customerCreditDict,
			diff_payment,
		} = options;
		const diff = unref(diff_payment) || 0;
		const writeOffAmount = getEffectiveWriteOffAmount(doc, profile, diff);

		const storeItemsSource = stores?.invoiceStore?.items;
		const liveCartItems = Array.isArray(storeItemsSource)
			? storeItemsSource
			: Array.isArray(storeItemsSource?.value)
				? storeItemsSource.value
				: [];
		const docLossRiskItems = findLossRiskItems(doc?.items || []);
		const lossRiskItems = docLossRiskItems.length
			? docLossRiskItems
			: findLossRiskItems(liveCartItems);
		if (lossRiskItems.length) {
			const first = lossRiskItems[0]!;
			throw new Error(
				__(
					"Cannot submit invoice because {0} is selling at {1}, below {2} {3}.",
					[
						first.itemName || first.itemCode,
						formatFloat(first.sellingRate, prec),
						first.costLabel,
						formatFloat(first.costRate, prec),
					],
				),
			);
		}

		// 1. Ensure return payments are negative
		if (doc.is_return) {
			ensureReturnPaymentsAreNegative();

			// Never refund more cash than was actually paid on the original
			// invoice. Mirrors the backend guard, but blocks here so the cashier
			// gets one clean message instead of a failed submit round-trip
			// (which the API layer would surface as a "connection problem").
			if (shouldApplyReturnRefundCap(doc)) {
				let refund = 0;
				(doc.payments || []).forEach((p: any) => {
					refund += Math.abs(formatFloat(p.amount, prec));
				});
				const refundable = formatFloat(
					doc.posa_refundable_amount,
					prec,
				);
				if (refund > refundable + 0.001) {
					throw new Error(
						__(
							'Cannot refund {0} for this return: only {1} was paid on the original invoice. Turn on "Store as Credit?" to record it as a credit note that reduces the customer\'s balance.',
							[refund, refundable],
						),
					);
				}
			}
		}

		let current_total_payments = 0;
		if (doc.payments) {
			doc.payments.forEach((p: any) => {
				current_total_payments += formatFloat(p.amount, prec);
			});
		}
		// Add loyalty and credit
		const loyaltyRedemption = getLoyaltyRedemptionForSubmission(doc);
		if (loyaltyRedemption.amount > 0)
			current_total_payments += loyaltyRedemption.amount;
		if (
			options.redeemedCustomerCredit &&
			unref(options.redeemedCustomerCredit)
		)
			current_total_payments += unref(options.redeemedCustomerCredit)!;
		if (
			options.giftCardRedemptions &&
			Array.isArray(unref(options.giftCardRedemptions))
		) {
			current_total_payments += unref(options.giftCardRedemptions).reduce(
				(sum: number, row: any) =>
					sum + formatFloat(row?.amount || 0, prec),
				0,
			);
		}

		const invoice_total = formatFloat(
			doc.rounded_total || doc.grand_total,
			prec,
		);
		const effective_total_payments = formatFloat(
			current_total_payments + writeOffAmount,
			prec,
		);
		const writeOffLimit = getWriteOffLimit(profile);
		const writeOffCappedByLimit =
			Boolean(unref(options.is_write_off_change)) &&
			writeOffLimit !== null &&
			diff > writeOffLimit + 0.001;
		const isCreditSale = Boolean(unref(options.is_credit_sale));
		const hasAnySettlement =
			effective_total_payments > 0 ||
			(Array.isArray(doc.payments)
				? doc.payments.some(
						(payment: any) =>
							formatFloat(payment?.amount || 0, prec) > 0,
					)
				: false);

		// 2. Validate total payments
		if (
			isCreditSale &&
			!doc.is_return &&
			!parseBooleanSetting(profile?.posa_allow_credit_sale)
		) {
			throw new Error(__("Credit Sale is not enabled in POS Profile"));
		}

		if (
			writeOffCappedByLimit &&
			!profile.posa_allow_partial_payment &&
			effective_total_payments < invoice_total - 0.001
		) {
			throw new Error(
				__(
					"Write off amount exceeds the allowed limit ({0}). Please add payment for the remaining amount.",
					[writeOffLimit],
				),
			);
		}

		if (
			!isCreditSale &&
			!doc.is_return &&
			!hasAnySettlement &&
			invoice_total > 0
		) {
			throw new Error(__("Please enter payment amount"));
		}

		// 3. Validate partial payments / cash payments
		if (!isCreditSale && !doc.is_return) {
			let has_cash_payment = false;
			let cash_amount = 0;
			if (doc.payments) {
				doc.payments.forEach((payment: any) => {
					if (
						payment.mode_of_payment.toLowerCase().includes("cash")
					) {
						has_cash_payment = true;
						cash_amount = formatFloat(payment.amount, prec);
					}
				});
			}

			if (has_cash_payment && cash_amount > 0) {
				if (
					!profile.posa_allow_partial_payment &&
					formatFloat(cash_amount + writeOffAmount, prec) <
						invoice_total &&
					invoice_total > 0
				) {
					throw new Error(
						__(
							"Cash payment cannot be less than invoice total when partial payment is not allowed",
						),
					);
				}
			}

			if (
				!profile.posa_allow_partial_payment &&
				effective_total_payments < invoice_total &&
				invoice_total > 0
			) {
				throw new Error(__("The amount paid is not complete"));
			}
		}

		// 4. Validate phone payment
		if (!payment_received && doc.payments) {
			let phone_payment_is_valid = true;
			doc.payments.forEach((payment: any) => {
				if (
					payment.type === "Phone" &&
					![0, "0", "", null, undefined].includes(payment.amount)
				) {
					phone_payment_is_valid = false;
				}
			});
			if (!phone_payment_is_valid) {
				throw new Error(
					__(
						"Please request phone payment or use another payment method",
					),
				);
			}
		}

		// 5. Validate paid_change
		const changeLimit = Math.max(-diff, 0);
		const pChange = unref(paidChange) || 0;
		if (pChange > changeLimit + 0.001) {
			throw new Error(
				__("Paid change cannot be greater than total change!"),
			);
		}

		// 6. Validate cashback
		const cChange = unref(creditChange) || 0;
		let total_change_calc = formatFloat(pChange + Math.abs(cChange), prec);
		if (
			unref(isCashback) &&
			Math.abs(total_change_calc - changeLimit) > 0.01
		) {
			throw new Error(__("Error in change calculations!"));
		}

		// 7. Validate customer credit redemption
		if (customerCreditDict?.value?.length) {
			let credit_calc_check = customerCreditDict.value.filter(
				(row: any) => {
					return (
						formatFloat(row.credit_to_redeem, prec) >
						formatFloat(row.total_credit, prec)
					);
				},
			);
			if (credit_calc_check.length > 0) {
				throw new Error(
					__("Redeemed credit cannot be greater than its total."),
				);
			}
		}

		if (
			!doc.is_return &&
			unref(redeemedCustomerCredit) !== undefined &&
			unref(redeemedCustomerCredit)! > invoice_total
		) {
			throw new Error(
				__("Cannot redeem customer credit more than invoice total"),
			);
		}

		const giftCardRows = Array.isArray(options.giftCardRedemptions?.value)
			? options.giftCardRedemptions?.value || []
			: [];
		const totalGiftCardRedemption = giftCardRows.reduce(
			(sum: number, row: any) =>
				sum + formatFloat(row?.amount || 0, prec),
			0,
		);
		const invalidGiftCardRow = giftCardRows.find(
			(row: any) =>
				formatFloat(row?.amount || 0, prec) > 0 &&
				!String(row?.gift_card_code || "").trim(),
		);
		if (invalidGiftCardRow) {
			throw new Error(__("Gift card code is required for redemption"));
		}
		if (!doc.is_return && totalGiftCardRedemption > invoice_total + 0.001) {
			throw new Error(
				__("Cannot redeem gift cards more than invoice total"),
			);
		}

		return true;
	};

	const normalizeLoyaltyRedemptionForSubmission = (doc: any) => {
		if (!doc) {
			return doc;
		}

		const clearLoyaltyRedemption = () => {
			doc.loyalty_amount = 0;
			doc.redeem_loyalty_points = 0;
			doc.loyalty_points = 0;
			return doc;
		};

		const loyaltyRedemption = getLoyaltyRedemptionForSubmission(doc);
		if (loyaltyRedemption.amount <= 0 || loyaltyRedemption.points <= 0) {
			return clearLoyaltyRedemption();
		}

		const info = unref(options.customerInfo) || {};
		if (!doc.loyalty_program && info.loyalty_program) {
			doc.loyalty_program = info.loyalty_program;
		}

		doc.loyalty_amount = loyaltyRedemption.amount;
		doc.redeem_loyalty_points = 1;
		doc.loyalty_points = loyaltyRedemption.points;
		return doc;
	};

	const buildSubmissionInvoiceDoc = (doc: any) => {
		const submissionDoc = JSON.parse(JSON.stringify(doc || {}));
		ensureInvoiceClientRequestId(submissionDoc);
		normalizeLoyaltyRedemptionForSubmission(submissionDoc);
		return submissionDoc;
	};

	function ensureReturnPaymentsAreNegative() {
		const doc = unref(invoiceDoc);
		if (!doc || !doc.is_return) {
			return;
		}
		// Check if any payment amount is set
		let hasPaymentSet = false;
		if (doc.payments) {
			doc.payments.forEach((payment: any) => {
				if (Math.abs(payment.amount) > 0) {
					hasPaymentSet = true;
				}
			});
		}

		// Credit returns intentionally keep payment rows at 0. If a non-zero row
		// exists, it still must be negative for ERPNext return validation.
		if (!hasPaymentSet && unref(options.isCashback) === false) {
			return;
		}

		// If no payment set, set the default one
		if (!hasPaymentSet && doc.payments) {
			const default_payment = doc.payments.find(
				(payment: any) => payment.default === 1,
			);
			if (default_payment) {
				const amount = doc.rounded_total || doc.grand_total;
				default_payment.amount = -Math.abs(amount);
				if (default_payment.base_amount !== undefined) {
					default_payment.base_amount = -Math.abs(
						toCompanyCurrency(currencyContext(doc), amount),
					);
				}
			}
		}
		// Ensure all set payments are negative
		if (doc.payments) {
			doc.payments.forEach((payment: any) => {
				if (payment.amount > 0) {
					payment.amount = -Math.abs(payment.amount);
				}
				if (
					payment.base_amount !== undefined &&
					payment.base_amount > 0
				) {
					payment.base_amount = -Math.abs(payment.base_amount);
				}
			});
		}
	}

	function restoreReturnPayments() {
		const doc = unref(invoiceDoc);
		if (!doc?.payments) {
			return;
		}

		doc.payments.forEach((payment: any) => {
			if (payment.amount < 0) {
				payment.amount = Math.abs(payment.amount);
			}
			if (payment.base_amount !== undefined && payment.base_amount < 0) {
				payment.base_amount = Math.abs(payment.base_amount);
			}
		});
	}

	const getOfflineSaleAuthorizationScope = (
		profile: any,
		doc: any,
	): OfflineSaleAuthorizationScope => ({
		posProfile: String(doc?.pos_profile || profile?.name || "").trim(),
		company: String(doc?.company || profile?.company || "").trim(),
		user: String((globalThis as any)?.frappe?.session?.user || "").trim(),
	});

	const assertOfflineCashSaleSubmission = (
		submissionDoc: any,
		data: any,
		ticket: OfflineCashSaleAuthorizationTicket,
		documentType: string,
	) => {
		if (!["Sales Invoice", "POS Invoice"].includes(documentType)) {
			throw new Error(
				__("Offline signed sales only support Sales Invoice and POS Invoice."),
			);
		}
		if (ticket.document_type !== documentType) {
			throw new Error(
				__("Offline cash-sale authorization belongs to a different invoice type."),
			);
		}
		const signedOwner = String(ticket.owner_user || "").trim();
		const activeUser = String(
			(globalThis as any)?.frappe?.session?.user || "",
		).trim();
		if (!signedOwner || !activeUser || signedOwner !== activeUser) {
			throw new Error(
				__("Offline cash-sale authorization belongs to a different signed-in user."),
			);
		}
		if (submissionDoc?.is_return || submissionDoc?.return_against || !submissionDoc?.is_pos) {
			throw new Error(__("Offline signed sales do not support returns."));
		}
		const finiteNumber = (value: unknown) => {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		};
		const nonZeroOrInvalid = (value: unknown) => {
			if (value === undefined || value === null || value === "") {
				return false;
			}
			const parsed = finiteNumber(value);
			return parsed === null || parsed !== 0;
		};
		if (
			data?.is_credit_sale ||
			data?.is_write_off_change ||
			nonZeroOrInvalid(data?.write_off_amount) ||
			nonZeroOrInvalid(data?.redeemed_customer_credit) ||
			nonZeroOrInvalid(data?.credit_change) ||
			nonZeroOrInvalid(submissionDoc?.loyalty_amount) ||
			submissionDoc?.redeem_loyalty_points ||
			(Array.isArray(data?.gift_card_redemptions) &&
				data.gift_card_redemptions.some(
					(row: any) => !row || nonZeroOrInvalid(row.amount),
				))
		) {
			throw new Error(
				__("Offline signed sales support ordinary cash sales only."),
			);
		}

		const companyCurrency = String(ticket.company_currency || "").trim();
		const invoiceCompanyCurrency = String(
			submissionDoc?.company_currency || "",
		).trim();
		const invoiceCurrency = String(submissionDoc?.currency || "").trim();
		if (!companyCurrency || (invoiceCompanyCurrency && invoiceCompanyCurrency !== companyCurrency)) {
			throw new Error(
				__("Offline cash-sale authorization belongs to a different company currency."),
			);
		}
		const baseTotal = finiteNumber(
			submissionDoc?.base_rounded_total ?? submissionDoc?.base_grand_total,
		);
		const total =
			baseTotal !== null
				? baseTotal
				: invoiceCurrency === companyCurrency
					? finiteNumber(
							submissionDoc?.rounded_total ?? submissionDoc?.grand_total,
						)
					: null;
		const maximum = finiteNumber(ticket.maximum_amount);
		if (total === null || total <= 0 || maximum === null || maximum <= 0 || total > maximum) {
			throw new Error(
				__("Offline cash sale exceeds its authorized maximum amount."),
			);
		}
		const paidRows: number[] = [];
		for (const payment of Array.isArray(submissionDoc?.payments)
			? submissionDoc.payments
			: []) {
			const amount = finiteNumber(payment?.amount);
			const hasBaseAmount = payment?.base_amount !== undefined && payment?.base_amount !== null;
			const baseAmount = hasBaseAmount ? finiteNumber(payment?.base_amount) : null;
			if (
				amount === null ||
				amount < 0 ||
				(hasBaseAmount && (baseAmount === null || baseAmount < 0))
			) {
				throw new Error(
					__("Offline signed sales cannot contain negative or invalid payment rows."),
				);
			}
			const companyAmount =
				baseAmount !== null
					? baseAmount
					: invoiceCurrency === companyCurrency
						? amount
						: null;
			if (companyAmount === null) {
				throw new Error(
					__("Offline signed sales in a foreign currency require a company-currency payment amount."),
				);
			}
			if (amount > 0 || companyAmount > 0) {
				if (
					String(payment?.mode_of_payment || "").trim() !==
					String(ticket.cash_mode_of_payment || "").trim()
				) {
					throw new Error(
						__("Offline signed sales must use the authorized cash payment method only."),
					);
				}
				paidRows.push(companyAmount);
			}
		}
		if (!paidRows.length) {
			throw new Error(
				__("Offline signed sales must use the authorized cash payment method only."),
			);
		}
		const paidTotal = paidRows.reduce((sum, amount) => sum + amount, 0);
		if (paidTotal + 0.001 < total) {
			throw new Error(
				__("Offline signed sales must be paid in full with cash."),
			);
		}
		const selectedCustomer = String(submissionDoc?.customer || "").trim();
		const hasQueuedCustomer = selectedCustomer && getOfflineCustomers().some(
			(entry: any) =>
				String(
					entry?.args?.customer_name || entry?.customer_name || "",
				).trim() === selectedCustomer,
		);
		if (hasQueuedCustomer) {
			// Customer creation can replace a temporary browser-only name with the
			// authoritative server name. That is a meaningful change to a signed
			// invoice, so require an online sale instead of mutating its immutable
			// outbox command during later customer synchronization.
			throw new Error(
				__("Offline signed sales cannot use a customer created while offline. Use an existing synced customer or complete this sale after reconnecting."),
			);
		}
		const stockValidation = validateStockForOfflineInvoice(
			submissionDoc?.items || [],
			submissionDoc,
		);
		if (!stockValidation.isValid) {
			throw new Error(stockValidation.errorMessage);
		}
	};

	const submitInvoice = async (
		print: boolean,
		callbacks: SubmissionCallbacks = {},
		submitOptions: SubmitInvoiceOptions = {},
	): Promise<any> => {
		const doc = unref(invoiceDoc);
		const profile = unref(posProfile);
		const type = unref(invoiceType);
		const submittingOffline = isOffline();
		const offlineSaleAuthorization =
			submitOptions.cashierSignature?.offlineSaleAuthorization || null;
		if (submittingOffline && offlineSaleAuthorization) {
			const boundRequestId = String(
				offlineSaleAuthorization.client_request_id || "",
			).trim();
			const existingRequestId = String(
				doc?.posa_client_request_id || "",
			).trim();
			if (!boundRequestId) {
				throw new Error(
					__("Offline cash-sale authorization is missing its request identity."),
				);
			}
			if (existingRequestId && existingRequestId !== boundRequestId) {
				throw new Error(
					__(
						"This cart already has a different submission identity. Reconnect before creating an offline sale.",
					),
				);
			}
			doc.posa_client_request_id = boundRequestId;
		}
		const prec = unref(options.currencyPrecision) || 2;
		const {
			isCashback,
			paidChange,
			creditChange,
			redeemedCustomerCredit,
			customerCreditDict,
			diff_payment,
		} = options;

		const {
			onSuccess,
			onPrint,
			onFinishNavigation,
			onScheduleBackgroundCheck,
		} = callbacks;

		if (submissionRecoveryLocked.value) {
			return {
				confirmationPending: true,
				requestId: submissionRecovery.value.requestId,
			};
		}

		if (doc.is_return) {
			ensureReturnPaymentsAreNegative();
		}

		let totalPayedAmount = 0;
		if (doc.payments) {
			doc.payments.forEach((payment: any) => {
				payment.amount = formatFloat(payment.amount, prec);
				totalPayedAmount += payment.amount;
			});
		}

		if (doc.is_return && totalPayedAmount === 0) {
			doc.is_pos = 0;
		}

		if (customerCreditDict?.value?.length) {
			customerCreditDict.value.forEach((row: any) => {
				row.credit_to_redeem = formatFloat(row.credit_to_redeem, prec);
			});
		}

		const diff = unref(diff_payment) || 0;
		const writeOffAmount = getEffectiveWriteOffAmount(doc, profile, diff);
		const changeLimit = !doc.is_return ? Math.max(-diff, 0) : 0;
		let pChange = !doc.is_return
			? formatFloat(Math.min(unref(paidChange) || 0, changeLimit), prec)
			: 0;
		let cChange = !doc.is_return
			? formatFloat(Math.max(changeLimit - pChange, 0), prec)
			: 0;

		if (
			!doc.is_return &&
			changeLimit > 0 &&
			pChange <= 0 &&
			Array.isArray(doc.payments)
		) {
			const configuredCashMop = String(
				profile?.posa_cash_mode_of_payment || "",
			).toLowerCase();
			const paidRows = doc.payments.filter(
				(payment: any) => formatFloat(payment?.amount || 0, prec) > 0,
			);
			const hasCashPaid = paidRows.some((payment: any) => {
				const mode = String(
					payment?.mode_of_payment || "",
				).toLowerCase();
				const type = String(payment?.type || "").toLowerCase();
				if (type === "cash") return true;
				if (configuredCashMop && mode === configuredCashMop)
					return true;
				return mode.includes("cash");
			});
			const hasNonCashPaid = paidRows.some((payment: any) => {
				const mode = String(
					payment?.mode_of_payment || "",
				).toLowerCase();
				const type = String(payment?.type || "").toLowerCase();
				if (type === "cash") return false;
				if (configuredCashMop && mode === configuredCashMop)
					return false;
				return !mode.includes("cash");
			});

			if (hasNonCashPaid && !hasCashPaid) {
				pChange = formatFloat(changeLimit, prec);
				cChange = 0;
			}
		}

		if (doc) {
			ensureInvoiceClientRequestId(doc);
			doc.write_off_amount = writeOffAmount;
			doc.base_write_off_amount = formatFloat(
				toCompanyCurrency(currencyContext(doc), writeOffAmount),
				prec,
			);
			doc.paid_change = pChange;
			doc.credit_change = cChange;
		}

		if (!doc.is_return) {
			if (creditChange) creditChange.value = cChange;
			if (paidChange) paidChange.value = pChange;
		}

		const submissionDoc = buildSubmissionInvoiceDoc(doc);
		const resolvedSubmissionDoctype = resolvePosDocumentDoctype({
			invoiceType: type,
			posProfile: profile,
		});
		const supportsInvoiceOutboxRecovery = [
			"Sales Invoice",
			"POS Invoice",
		].includes(resolvedSubmissionDoctype);

		const data = {
			total_change: changeLimit,
			paid_change: pChange,
			credit_change: cChange,
			is_credit_sale: unref(options.is_credit_sale) ? 1 : 0,
			is_write_off_change: unref(options.is_write_off_change) ? 1 : 0,
			write_off_amount: writeOffAmount,
			redeemed_customer_credit: unref(redeemedCustomerCredit),
			customer_credit_dict: unref(customerCreditDict),
			gift_card_redemptions: unref(options.giftCardRedemptions) || [],
			is_cashback: unref(isCashback),
		};
		ensureInvoiceSubmissionIdentity(submissionDoc, data);
		const hasGiftCardRedemption =
			Array.isArray(data.gift_card_redemptions) &&
			data.gift_card_redemptions.some(
				(row: any) => formatFloat(row?.amount || 0, prec) > 0,
			);
		const hasPostSubmitPaymentWork =
			Boolean(profile?.posa_allow_submissions_in_background_job) &&
			(formatFloat(unref(redeemedCustomerCredit) || 0, prec) > 0 ||
				hasGiftCardRedemption ||
				pChange > 0 ||
				cChange > 0);
		const requiresCashierSignature = isCashierSignedInvoiceSubmission(
			profile,
			type,
		);
		const cashierPin = String(
			submitOptions.cashierSignature?.cashierPin || "",
		).trim();
		// A cashier PIN is deliberately transient: it cannot be placed in the
		// browser journal or IndexedDB outbox. Therefore a PIN-authorized direct
		// submission cannot be replayed automatically after an ambiguous result.
		// Keep its durable pointer in manual-review mode instead; a cashier must
		// re-authorize any controlled retry with a fresh PIN.
		const requiresTransientCashierAuthorization =
			requiresCashierSignature && Boolean(cashierPin);
		const supportsAutomaticInvoiceOutboxRecovery =
			supportsInvoiceOutboxRecovery &&
			!requiresTransientCashierAuthorization;

		let durableIntent = false;
		let recoveryPointerPersisted = false;
		let submissionDispatched = false;
		let intent: {
			data: any;
			invoice: any;
			offline_sale_authorization?: string | null;
		} | null = null;
		let outboxPersistPromise: Promise<any> = Promise.resolve(null);
		const lockAcknowledgedClientCompletion = (
			invoiceName: string | null,
			queued: boolean,
			error: unknown,
			completionOptions: {
				cartIdentityMismatch?: boolean;
				detail?: string;
			} = {},
		) => {
			console.error(
				"Server acknowledged the submission but client completion is locked",
				error,
			);
			stopSubmissionRecoveryMonitor();
			activeRecoveryCallbacks = { ...callbacks };
			activeRecoveryPrint = Boolean(
				getActiveInvoiceSubmissionRecovery()?.printRequested ?? print,
			);
			activeRecoveryMode = supportsAutomaticInvoiceOutboxRecovery
				? "invoice_outbox"
				: "manual_only";
			const detail =
				completionOptions.detail ||
				__(
					"The server accepted this document, but the browser could not safely finish it. Do not retry; ask a supervisor to verify its status.",
				);
			submissionRecovery.value = {
				phase: "manual_review",
				requestId: submissionDoc.posa_client_request_id,
				invoiceName,
				detail,
			};
			showRecoveryToast(
				"manual_review",
				submissionDoc.posa_client_request_id,
				detail,
			);
			return {
				confirmationPending: true,
				serverAcknowledged: true,
				queued,
				clientCompletionFailed: true,
				cartIdentityMismatch: Boolean(
					completionOptions.cartIdentityMismatch,
				),
				requestId: submissionDoc.posa_client_request_id,
			};
		};
		const completeDirectRecoveryCheckpoint = () => {
			const pointerCleared = clearActiveInvoiceSubmissionRecovery(
				submissionDoc.posa_client_request_id,
			);
			if (pointerCleared) {
				clearInvoiceRecoveryClientEffects(
					submissionDoc.posa_client_request_id,
				);
			}
			return pointerCleared;
		};
		const finalizeDirectSubmittedOutbox = async (response: {
			name: string;
			doctype: "Sales Invoice" | "POS Invoice";
			docstatus?: number | string;
			status?: number | string;
			nestedDocstatus?: number | string;
			nestedStatus?: number | string;
		}) => {
			if (!durableIntent || !intent) {
				return null;
			}
			await outboxPersistPromise;
			return finalizeAcknowledgedInvoiceOutboxEntry(
				submissionDoc.posa_client_request_id,
				intent,
				{
					acknowledged: true,
					client_request_id: submissionDoc.posa_client_request_id,
					invoice: {
						name: response.name,
						doctype: response.doctype,
						...(response.nestedDocstatus !== undefined
							? { docstatus: response.nestedDocstatus }
							: {}),
						...(response.nestedStatus !== undefined
							? { status: response.nestedStatus }
							: {}),
					},
					...(response.docstatus !== undefined
						? { docstatus: response.docstatus }
						: {}),
					...(response.status !== undefined
						? { status: response.status }
						: {}),
				},
			);
		};
		const discardPendingDirectOutbox = async () => {
			if (!durableIntent || !intent) {
				return 0;
			}
			await outboxPersistPromise;
			return removeInvoiceOutboxEntry(
				submissionDoc.posa_client_request_id,
				intent,
				"pending",
			);
		};

		if (submittingOffline) {
			if (!requiresCashierSignature || !offlineSaleAuthorization) {
				throw new Error(
					__(
						"No prepared offline cash-sale authorization is available. Reconnect and have the cashier sign a sale before working offline.",
					),
				);
			}
			if (cashierPin) {
				throw new Error(
					__("Offline sales must not retain or submit a cashier PIN."),
				);
			}
			const expiresAt = Date.parse(
				String(offlineSaleAuthorization.expires_at || ""),
			);
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
				throw new Error(
					__(
						"The prepared offline cash-sale authorization has expired. Reconnect and prepare another one.",
					),
				);
			}
			assertOfflineCashSaleSubmission(
				submissionDoc,
				data,
				offlineSaleAuthorization,
				resolvedSubmissionDoctype,
			);
			const authorizationScope = getOfflineSaleAuthorizationScope(
				profile,
				submissionDoc,
			);
			const offlineIntent = {
				data,
				invoice: submissionDoc,
				offline_sale_authorization:
					offlineSaleAuthorization.authorization,
			};
			intent = offlineIntent;
			try {
				persistActiveInvoiceSubmissionRecovery({
					requestId: submissionDoc.posa_client_request_id,
					invoiceName: submissionDoc.name || doc?.name || null,
					documentType: resolvedSubmissionDoctype,
					recoveryMode: "invoice_outbox",
					posProfile:
						submissionDoc.pos_profile || doc?.pos_profile || profile?.name,
					company:
						submissionDoc.company || doc?.company || profile?.company,
					user: (globalThis as any)?.frappe?.session?.user,
					cartFingerprint: buildInvoiceRecoveryCartFingerprint(
						doc,
						getLiveCartItems(),
					),
					printRequested: false,
				});
				recoveryPointerPersisted = true;
					await enqueueInvoiceOutboxEntry(offlineIntent);
				durableIntent = true;
				// Durable outbox ownership is the source of truth. A crash or a
				// secondary IndexedDB write failure here is reconciled from that row
				// on the next load; it must not make an already queued sale look
				// failed or invite an unsafe retry.
				try {
					const consumed = await consumeOfflineCashSaleAuthorization(
						authorizationScope,
						submissionDoc.posa_client_request_id,
					);
					if (!consumed) {
						console.warn(
							"Offline cash-sale ticket state will be reconciled from its durable outbox entry",
							submissionDoc.posa_client_request_id,
						);
					}
				} catch (ticketStateError) {
					console.warn(
						"Unable to finalize offline cash-sale ticket state; durable outbox recovery remains authoritative",
						ticketStateError,
					);
				}

				const applyClientEffects = claimInvoiceRecoveryClientEffects(
					submissionDoc.posa_client_request_id,
				);
				if (applyClientEffects) {
					const submittedItems = Array.isArray(submissionDoc.items)
						? submissionDoc.items
						: [];
					updateLocalStock(submittedItems);
					stockCoordinator.applyInvoiceConsumption(submittedItems, {
						source: "offline_invoice",
					});
					stores?.uiStore?.setLastStockAdjustment?.({
						items: submittedItems,
						item_codes: submittedItems
							.map((item: any) => item?.item_code)
							.filter((code: unknown) => code !== undefined && code !== null),
						timestamp: Date.now(),
					});
					stores?.toastStore?.show({
						title: __("Offline cash sale queued"),
						detail: __(
							"The sale is stored securely on this device and will sync when the POS reconnects.",
						),
						color: "info",
					});
					if (customerCreditDict) customerCreditDict.value = [];
					onSuccess?.({
						queued: true,
						offline: true,
						client_request_id: submissionDoc.posa_client_request_id,
					});
					onFinishNavigation?.(true);
				}
				if (!completeDirectRecoveryCheckpoint()) {
					throw new Error(
						__(
							"The offline sale was queued but this browser could not clear its recovery checkpoint. Do not retry; ask a supervisor to review the outbox.",
						),
					);
				}
				return {
					success: true,
					queued: true,
					offline: true,
					message: {
						client_request_id: submissionDoc.posa_client_request_id,
						queued: true,
					},
				};
			} catch (offlineError) {
				if (!durableIntent) {
					await releaseOfflineCashSaleAuthorization(
						authorizationScope,
						submissionDoc.posa_client_request_id,
					).catch(() => false);
					if (recoveryPointerPersisted) {
						completeDirectRecoveryCheckpoint();
					}
				}
				(offlineError as any).posaOfflineSaleDurable = durableIntent;
				throw offlineError;
			}
		}

		// Online Submission
		try {
			await validateStockBeforeOnlineSubmission(doc, profile, type);
			intent = { data, invoice: submissionDoc };
			if (supportsAutomaticInvoiceOutboxRecovery) {
				persistInvoiceIntentJournal(intent);
				durableIntent = true;
			}
			try {
				persistActiveInvoiceSubmissionRecovery({
					requestId: submissionDoc.posa_client_request_id,
					invoiceName: submissionDoc.name || doc?.name || null,
					documentType: resolvedSubmissionDoctype,
					recoveryMode: supportsAutomaticInvoiceOutboxRecovery
						? "invoice_outbox"
						: "manual_only",
					posProfile:
						submissionDoc.pos_profile ||
						doc?.pos_profile ||
						profile?.name,
					company:
						submissionDoc.company ||
						doc?.company ||
						profile?.company,
					user: (globalThis as any)?.frappe?.session?.user,
					cartFingerprint: buildInvoiceRecoveryCartFingerprint(
						doc,
						getLiveCartItems(),
					),
					printRequested: print,
				});
				recoveryPointerPersisted = true;
			} catch (persistenceError) {
				clearActiveInvoiceSubmissionRecovery(
					submissionDoc.posa_client_request_id,
				);
				if (durableIntent && intent) {
					await removeInvoiceOutboxEntry(
						submissionDoc.posa_client_request_id,
						intent,
						"pending",
					).catch(() => 0);
				}
				const failClosedError: any = new Error(
					__(
						"The sale was not sent because this browser could not save its recovery checkpoint. The cart is still available; ask a supervisor before retrying.",
					),
				);
				failClosedError.code = "RECOVERY_PERSISTENCE_FAILED";
				failClosedError.cause = persistenceError;
				failClosedError.posaRecoveryPersistenceFailed = true;
				throw failClosedError;
			}
			if (supportsAutomaticInvoiceOutboxRecovery) {
				outboxPersistPromise = enqueueInvoiceOutboxEntry(intent).catch(
					(error) => {
						console.warn(
							"Invoice intent remains in the synchronous recovery journal",
							error,
						);
					},
				);
			}
			const submitArgs: any[] = [data, submissionDoc, type, profile];
			if (requiresCashierSignature && cashierPin) {
				submitArgs.push(cashierPin);
			}
			const submitRequest = (invoiceService.submitInvoice as any)(
				...submitArgs,
			);
			submissionDispatched = true;
			if (typeof window !== "undefined") {
				try {
					window.dispatchEvent(
						new CustomEvent("posa:invoice-submit-dispatched", {
							detail: {
								requestId: submissionDoc.posa_client_request_id,
								timestamp: performance.now(),
							},
						}),
					);
				} catch (signalError) {
					console.warn(
						"Unable to publish invoice dispatch browser signal",
						signalError,
					);
				}
			}
			const message = unwrapApiResult(await submitRequest);

			const r = { message };

			if (!r.message) {
				const reason = __("No response from server");
				const failedInfo = {
					invoice: doc?.name,
					reason,
				};

				const err: any = new Error(reason);
				err.failedInfo = failedInfo;
				err.posaAmbiguousSubmission = true;
				throw err;
			}

			const docstatus = r.message?.docstatus;
			const status = r.message?.status;
			const nestedResponseInvoice =
				r.message?.invoice && typeof r.message.invoice === "object"
					? r.message.invoice
					: null;
			const suppliedStatusValues = [
				docstatus,
				status,
				nestedResponseInvoice?.docstatus,
				nestedResponseInvoice?.status,
			].filter(
				(value) =>
					value !== null && value !== undefined && value !== "",
			);
			const numericStatusValues = suppliedStatusValues.map((value) =>
				Number(value),
			);
			const responseInvoiceName = String(r.message?.name || "").trim();
			const responseDoctype = String(r.message?.doctype || "").trim();
			const responseClientRequestId = String(
				r.message?.client_request_id || "",
			).trim();
			const backgroundReason =
				r.message?.error ||
				r.message?.exc ||
				r.message?.exception ||
				r.message?.message;

			const explicitlyQueued =
				r.message?.queued === true &&
				numericStatusValues.length > 0 &&
				numericStatusValues.every((value) => value === 0);
			const submittedQueueSignalIsConsistent =
				r.message?.queued === undefined || r.message?.queued === false;
			const wasSubmitted =
				submittedQueueSignalIsConsistent &&
				numericStatusValues.length > 0 &&
				numericStatusValues.every((value) => value === 1);
			const responseIdentityMatches =
				Boolean(responseInvoiceName) &&
				(supportsInvoiceOutboxRecovery
					? responseDoctype === resolvedSubmissionDoctype &&
						responseClientRequestId ===
							submissionDoc.posa_client_request_id
					: !responseDoctype ||
						responseDoctype === resolvedSubmissionDoctype);
			if (
				(!wasSubmitted && !explicitlyQueued) ||
				!responseIdentityMatches
			) {
				const reason = __(
					"The server response did not explicitly confirm this document and request identity.",
				);
				const err: any = new Error(reason);
				err.failedInfo = {
					invoice: responseInvoiceName,
					reason,
				};
				err.posaAmbiguousSubmission = true;
				throw err;
			}
			if (wasSubmitted && supportsAutomaticInvoiceOutboxRecovery) {
				try {
					await finalizeDirectSubmittedOutbox({
						name: responseInvoiceName,
						doctype: responseDoctype as
							| "Sales Invoice"
							| "POS Invoice",
						docstatus,
						status,
						nestedDocstatus: nestedResponseInvoice?.docstatus,
						nestedStatus: nestedResponseInvoice?.status,
					});
				} catch (outboxFinalizationError) {
					return lockAcknowledgedClientCompletion(
						responseInvoiceName || null,
						false,
						outboxFinalizationError,
					);
				}
			}
			const directCartIdentityStatus = getRecoveryCartIdentityStatus(
				getActiveInvoiceSubmissionRecovery(),
			);
			if (!directCartIdentityStatus.safe) {
				return lockAcknowledgedClientCompletion(
					responseInvoiceName || null,
					explicitlyQueued,
					new Error(directCartIdentityStatus.detail || undefined),
					{
						cartIdentityMismatch: true,
						detail: directCartIdentityStatus.detail || undefined,
					},
				);
			}
			const waitForInvoiceProcessing = explicitlyQueued;
			const submittedDoctype =
				responseDoctype ||
				doc?.doctype ||
				(profile?.create_pos_invoice_instead_of_sales_invoice
					? "POS Invoice"
					: "Sales Invoice");
			const submittedDocstatus = explicitlyQueued ? 0 : 1;
			const submittedDocument = {
				...doc,
				...(typeof r.message === "object" ? r.message : {}),
				name: responseInvoiceName,
				doctype: submittedDoctype,
				docstatus: submittedDocstatus,
			};
			let shouldApplyDirectClientEffects: boolean;
			try {
				shouldApplyDirectClientEffects =
					claimInvoiceRecoveryClientEffects(
						submissionDoc.posa_client_request_id,
					);
			} catch (clientEffectsClaimError) {
				return lockAcknowledgedClientCompletion(
					responseInvoiceName || null,
					explicitlyQueued,
					clientEffectsClaimError,
				);
			}
			if (!shouldApplyDirectClientEffects) {
				try {
					stores?.invoiceStore?.mergeInvoiceDoc?.({
						docstatus: submittedDocstatus,
						name: responseInvoiceName,
						doctype: submittedDoctype,
					});
					if (responseInvoiceName) {
						stores?.uiStore?.setLastInvoice?.(responseInvoiceName);
					}
					onFinishNavigation?.(true);
				} catch (idempotentCompletionError) {
					return lockAcknowledgedClientCompletion(
						responseInvoiceName || null,
						explicitlyQueued,
						idempotentCompletionError,
					);
				}
				const pointerCleared = completeDirectRecoveryCheckpoint();
				if (!pointerCleared) {
					return lockAcknowledgedClientCompletion(
						responseInvoiceName || null,
						explicitlyQueued,
						new Error(
							"Unable to clear the active recovery pointer",
						),
					);
				}
				return {
					success: true,
					alreadySettled: true,
					clientEffectsApplied: false,
					message: r.message,
				};
			}
			if (typeof window !== "undefined") {
				try {
					window.dispatchEvent(
						new CustomEvent("posa:invoice-submit-response", {
							detail: {
								requestId: submissionDoc.posa_client_request_id,
								invoice: responseInvoiceName,
								doctype: submittedDoctype,
								wasSubmitted,
								docstatus,
								status,
								queued: explicitlyQueued,
								ledgerState: r.message?.ledger_state,
								timestamp: performance.now(),
							},
						}),
					);
				} catch (signalError) {
					console.warn(
						"Unable to publish invoice response browser signal",
						signalError,
					);
				}
			}
			if (wasSubmitted && typeof window !== "undefined") {
				try {
					window.dispatchEvent(
						new CustomEvent("posa:invoice-submit-authoritative", {
							detail: {
								requestId: submissionDoc.posa_client_request_id,
								invoice: responseInvoiceName,
								doctype: submittedDoctype,
								timestamp: performance.now(),
							},
						}),
					);
				} catch (signalError) {
					console.warn(
						"Unable to publish authoritative invoice browser signal",
						signalError,
					);
				}
			}

			if (explicitlyQueued && backgroundReason) {
				const failedInfo = {
					invoice: responseInvoiceName,
					reason: backgroundReason,
				};

				// Background job specific logic
				if (profile?.posa_allow_submissions_in_background_job) {
					try {
						stores?.toastStore?.show({
							title: __("Error submitting invoice: {0}", [
								responseInvoiceName || "",
							]),
							color: "error",
							detail: backgroundReason,
						});
						onFinishNavigation?.(true);
						if (onScheduleBackgroundCheck) {
							onScheduleBackgroundCheck({
								name: responseInvoiceName,
								doctype: r.message?.doctype,
								print,
								waitForPostSubmitPayments: false,
								waitForInvoiceProcessing: true,
							});
						}
					} catch (clientCompletionError) {
						return lockAcknowledgedClientCompletion(
							responseInvoiceName || null,
							true,
							clientCompletionError,
						);
					}
					if (!completeDirectRecoveryCheckpoint()) {
						return lockAcknowledgedClientCompletion(
							responseInvoiceName || null,
							true,
							new Error(
								"Unable to clear the active recovery pointer",
							),
						);
					}
					// Return special status indicating background failure handled
					return {
						backgroundFailure: true,
						reason: backgroundReason,
					};
				}

				const err: any = new Error(backgroundReason);
				err.failedInfo = failedInfo;
				throw err;
			}

			try {
				// Success
				if (
					print &&
					onPrint &&
					!waitForInvoiceProcessing &&
					!hasPostSubmitPaymentWork
				) {
					onPrint(submittedDocument, {
						name: responseInvoiceName,
						doctype: submittedDoctype,
						waitForPostSubmitPayments: hasPostSubmitPaymentWork,
						waitForInvoiceProcessing,
					});
				}

				// Reset local state vars
				if (customerCreditDict) customerCreditDict.value = [];

				stores?.invoiceStore?.mergeInvoiceDoc?.({
					docstatus: submittedDocstatus,
					name: responseInvoiceName,
					doctype: submittedDoctype,
				});

				if (stores?.uiStore) {
					stores.uiStore.setLastInvoice(responseInvoiceName);
				}

				if (!waitForInvoiceProcessing) {
					const submittedDocumentType = resolvePosDocumentDoctype({
						invoiceType: type,
						posProfile: profile,
					});
					const submittedTitle =
						submittedDocumentType === "Sales Order"
							? __("Sales Order {0} is Submitted", [
									responseInvoiceName,
								])
							: submittedDocumentType === "Quotation"
								? __("Quotation {0} is Submitted", [
										responseInvoiceName,
									])
								: __("Invoice {0} is Submitted", [
										responseInvoiceName,
									]);
					stores?.toastStore?.show(
						hasPostSubmitPaymentWork
							? {
									key: `invoice-processing::${responseInvoiceName}`,
									title: __("Invoice Submitted"),
									summary: submittedTitle,
									detail: __(
										"Processing payment entries for Invoice {0}",
										[responseInvoiceName],
									),
									color: "info",
									timeout: -1,
									loading: true,
								}
							: {
									key: `invoice-processing::${responseInvoiceName}`,
									title: submittedTitle,
									color: "success",
								},
					);
				}

				if (frappe?.utils?.play_sound) {
					frappe.utils.play_sound("submit");
				}

				const submittedItems = Array.isArray(submittedDocument.items)
					? submittedDocument.items
					: [];
				updateLocalStock(submittedItems);
				stockCoordinator.applyInvoiceConsumption(submittedItems, {
					source: "invoice",
				});
				const submittedCodes = submittedItems
					.map((item) => (item ? item.item_code : null))
					.filter((code) => code !== undefined && code !== null);

				if (stores?.uiStore) {
					stores.uiStore.setLastStockAdjustment({
						items: submittedItems,
						item_codes: submittedCodes,
						timestamp: Date.now(),
					});
				}

				if (onFinishNavigation) onFinishNavigation(true);

				if (stores?.customersStore?.setSelectedCustomer) {
					stores.customersStore.setSelectedCustomer(
						profile?.customer || null,
					);
				}

				if (
					onScheduleBackgroundCheck &&
					(waitForInvoiceProcessing || hasPostSubmitPaymentWork)
				) {
					onScheduleBackgroundCheck({
						name: responseInvoiceName,
						doctype: submittedDoctype,
						print,
						waitForPostSubmitPayments: hasPostSubmitPaymentWork,
						waitForInvoiceProcessing,
					});
				}

				if (onSuccess) {
					onSuccess(r.message);
				}
			} catch (clientCompletionError) {
				return lockAcknowledgedClientCompletion(
					responseInvoiceName || null,
					explicitlyQueued,
					clientCompletionError,
				);
			}

			const pointerCleared = completeDirectRecoveryCheckpoint();
			if (!pointerCleared) {
				return lockAcknowledgedClientCompletion(
					responseInvoiceName || null,
					explicitlyQueued,
					new Error("Unable to clear the active recovery pointer"),
				);
			}
			return { success: true, message: r.message };
		} catch (exc: any) {
			const errorCode = getSubmissionErrorCode(exc);
			const requestId = isApiEnvelopeError(exc)
				? exc.requestId
				: undefined;
			const isAmbiguousFailure =
				recoveryPointerPersisted &&
				submissionDispatched &&
				isAmbiguousInvoiceSubmissionFailure(exc);
			if (isAmbiguousFailure) {
				console.warn(
					"Invoice submission outcome is ambiguous; reconciling",
					{
						code: errorCode,
						requestId,
					},
				);
				const recovery = beginSubmissionRecovery(
					submissionDoc.posa_client_request_id,
					callbacks,
				);
				if (supportsAutomaticInvoiceOutboxRecovery) {
					void outboxPersistPromise.then(async () => {
						if (!intent) {
							return;
						}
						await enqueueInvoiceOutboxEntry(intent).catch(
							(error) => {
								console.warn(
									"Invoice recovery is using the synchronous intent journal",
									error,
								);
							},
						);
					});
				}
				return recovery;
			}

			console.error("Error submitting invoice:", {
				code: errorCode,
				requestId,
				error: exc,
			});
			const errorMsg = extractSubmissionErrorMessage(exc);

			if (errorCode === "TIMESTAMP_MISMATCH") {
				const submittedStatus = await fetchSubmittedDocstatus(doc);
				if (submittedStatus === 1) {
					// A name/docstatus lookup does not prove the immutable request
					// identity. Keep the tender locked until the outbox reconciliation
					// endpoint returns an exact request/type/status acknowledgement.
					return beginSubmissionRecovery(
						submissionDoc.posa_client_request_id,
						callbacks,
					);
				}
			}

			if (errorCode === "RETURN_PAYMENT_AMOUNT_SIGN") {
				try {
					await discardPendingDirectOutbox();
				} catch (cleanupError) {
					console.warn(
						"Return payment correction could not safely release its durable request",
						cleanupError,
					);
					return beginSubmissionRecovery(
						submissionDoc.posa_client_request_id,
						callbacks,
					);
				}
				if (!completeDirectRecoveryCheckpoint()) {
					return beginSubmissionRecovery(
						submissionDoc.posa_client_request_id,
						callbacks,
					);
				}
				stores?.toastStore?.show({
					title: __("Fixing payment amounts for return invoice..."),
					color: "warning",
				});

				if (doc.payments) {
					doc.payments.forEach((payment: any) => {
						if (payment.amount > 0)
							payment.amount = -Math.abs(payment.amount);
						if (payment.base_amount > 0)
							payment.base_amount = -Math.abs(
								payment.base_amount,
							);
					});
				}
				// Retry
				console.log("Retrying submission with fixed payment amounts");
				return new Promise((resolve) =>
					setTimeout(
						() =>
							resolve(
								submitInvoice(print, callbacks, submitOptions),
							),
						500,
					),
				);
			}

			if (recoveryPointerPersisted && submissionDispatched) {
				try {
					await discardPendingDirectOutbox();
				} catch (cleanupError) {
					console.warn(
						"Definite submission failure could not safely release its durable request",
						cleanupError,
					);
					return beginSubmissionRecovery(
						submissionDoc.posa_client_request_id,
						callbacks,
					);
				}
				if (!completeDirectRecoveryCheckpoint()) {
					return beginSubmissionRecovery(
						submissionDoc.posa_client_request_id,
						callbacks,
					);
				}
			}

			stores?.toastStore?.show(
				buildSubmissionFailureToast(exc, errorMsg),
			);
			exc.posaToastHandled = true;

			if (profile?.posa_allow_submissions_in_background_job) {
				if (onFinishNavigation) onFinishNavigation(true);
				if (onScheduleBackgroundCheck) {
					onScheduleBackgroundCheck({
						name: doc?.name,
						doctype: doc?.doctype,
						print,
						waitForPostSubmitPayments: false,
						waitForInvoiceProcessing: true,
					});
				}
			}

			throw exc;
		}
	};

	return {
		validateDueDate,
		ensureReturnPaymentsAreNegative,
		restoreReturnPayments,
		validateSubmission,
		submitInvoice,
		extractSubmissionErrorMessage,
		submissionRecovery,
		submissionRecoveryLocked,
		submissionRecoveryChecking,
		submissionRecoveryCanCheckStatus,
		submissionRecoveryCanResolveManually,
		submissionRecoveryCanReauthorizeCashier,
		submissionRecoveryDocumentType,
		refreshSubmissionRecoveryStatus,
		resumePendingSubmissionRecovery,
		manuallyReconcilePendingSubmission,
		resolveManualOnlySubmissionRecovery,
	stopSubmissionRecoveryMonitor,
	resetSubmissionRecovery,
	releaseCashierSignedSubmissionRecovery,
	};
}
