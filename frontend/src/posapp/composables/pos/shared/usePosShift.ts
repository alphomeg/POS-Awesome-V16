import { ref, getCurrentInstance, inject } from "vue";
import { useToastStore } from "../../../stores/toastStore.js";
import { useUIStore } from "../../../stores/uiStore.js";
import { useInvoiceStore } from "../../../stores/invoiceStore";
import {
	initPromise,
	checkDbHealth,
	getOpeningStorage,
	setOpeningStorage,
	clearOpeningStorage,
	setTaxTemplate,
	isOffline,
	getBootstrapSnapshot,
	setBootstrapSnapshot,
	isOfflineStorageReady,
} from "../../../../offline/index";
import { getValidCachedOpeningForCurrentUser } from "../../../utils/openingCache";
import { createBootstrapSnapshotFromRegisterData } from "../../../../offline/bootstrapSnapshot";
import { warmSalesPersonOptions } from "../../../services/salesPersonService";

declare const __BUILD_VERSION__: string;
declare const frappe: any;

type SkippedPrintedInvoice = {
	invoice?: string;
	doctype?: string;
	return_against?: string;
};

type ClosingShiftPreparationResponse = {
	closing_shift?: any;
	skipped_printed_invoices?: SkippedPrintedInvoice[];
};

type ClosingSubmissionStatus = {
	ready: boolean;
	pending_count: number;
	failed_count: number;
	pending?: Array<Record<string, any>>;
	failed?: Array<Record<string, any>>;
	timed_out?: boolean;
};

type ClosingSubmissionWaitOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	call?: (openingShift: string) => Promise<any>;
	sleep?: (delayMs: number) => Promise<void>;
	onStatus?: (status: ClosingSubmissionStatus) => void;
};

const CLOSING_SUBMISSION_STATUS_METHOD =
	"posawesome.posawesome.doctype.pos_closing_shift.pos_closing_shift.get_closing_submission_status";
const CLOSING_SUBMISSION_WAIT_MS = 45_000;
const CLOSING_SUBMISSION_POLL_MS = 350;

const translateMessage = (value: string) => (typeof window !== "undefined" && window.__
	? window.__(value)
	: value);

export function buildSkippedClosingInvoicesPrompt(
	skippedInvoices: SkippedPrintedInvoice[],
) {
	const count = skippedInvoices.length;
	const baseMessage = count === 1
		? "1 printed return invoice references a cancelled invoice and will be excluded from closing."
		: `${count} printed return invoices reference cancelled invoices and will be excluded from closing.`;
	const details = skippedInvoices
		.slice(0, 5)
		.map((invoice) => {
			const invoiceName = invoice?.invoice || translateMessage("Unknown invoice");
			const returnAgainst = invoice?.return_against;
			return returnAgainst
				? `${invoiceName} (${translateMessage("Return Against")}: ${returnAgainst})`
				: invoiceName;
		})
		.join(", ");
	const detailMessage = details
		? `${translateMessage("Invoices")}: ${details}.`
		: "";
	return [
		translateMessage(baseMessage),
		detailMessage,
		translateMessage("The skipped invoice will remain a draft."),
		translateMessage("Do you want to proceed?"),
	]
		.filter(Boolean)
		.join(" ");
}

function normalizeClosingShiftPreparationResponse(
	payload: any,
): ClosingShiftPreparationResponse {
	if (payload?.closing_shift || payload?.skipped_printed_invoices) {
		return payload;
	}

	return {
		closing_shift: payload,
		skipped_printed_invoices: [],
	};
}

export async function waitForClosingShiftSubmissions(
	openingShift: string,
	options: ClosingSubmissionWaitOptions = {},
): Promise<ClosingSubmissionStatus> {
	const timeoutMs = options.timeoutMs ?? CLOSING_SUBMISSION_WAIT_MS;
	const intervalMs = options.intervalMs ?? CLOSING_SUBMISSION_POLL_MS;
	const call = options.call || (async (name: string) =>
		frappe.call(CLOSING_SUBMISSION_STATUS_METHOD, {
			opening_shift: name,
		}));
	const sleep = options.sleep || ((delayMs: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
	const deadline = Date.now() + timeoutMs;
	let lastStatus: ClosingSubmissionStatus = {
		ready: false,
		pending_count: 0,
		failed_count: 0,
	};

	while (Date.now() <= deadline) {
		const response = await call(openingShift);
		lastStatus = (response?.message || response || lastStatus) as ClosingSubmissionStatus;
		options.onStatus?.(lastStatus);
		if (lastStatus.ready || lastStatus.failed_count > 0) {
			return lastStatus;
		}
		await sleep(intervalMs);
	}

	return { ...lastStatus, timed_out: true };
}

export function usePosShift(openDialog?: () => void) {
	const instance = getCurrentInstance();
	const proxy: any = instance?.proxy;
	const eventBus: any = proxy?.eventBus || inject("eventBus");
	const buildVersion =
		typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : null;
	const toastStore = useToastStore();
	const uiStore = useUIStore();

	const pos_profile = ref<any>(null);
	const pos_opening_shift = ref<any>(null);

	async function waitForClosingSubmissionsWithToast(openingShift: string) {
		let announced = false;
		const status = await waitForClosingShiftSubmissions(openingShift, {
			onStatus: (current) => {
				if (!current.ready && !current.failed_count && !announced) {
					announced = true;
					toastStore.show({
						key: `shift-close-finalization::${openingShift}`,
						title: translateMessage("Finishing recent sales"),
						detail: translateMessage(
							"The shift will be ready to close as soon as acknowledged sales finish processing.",
						),
						color: "info",
						timeout: -1,
						loading: true,
					});
				}
			},
		});

		if (status.ready) {
			if (announced) {
				toastStore.show({
					key: `shift-close-finalization::${openingShift}`,
					title: translateMessage("Recent sales finalized"),
					color: "success",
					timeout: 2500,
					loading: false,
				});
			}
			return true;
		}

		if (status.failed_count > 0) {
			const invoices = (status.failed || [])
				.map((row) => row.invoice || row.client_request_id)
				.filter(Boolean)
				.slice(0, 3)
				.join(", ");
			toastStore.show({
				key: `shift-close-finalization::${openingShift}`,
				title: translateMessage("Shift close needs supervisor review"),
				detail: invoices
					? `${translateMessage("Unresolved sales")}: ${invoices}`
					: translateMessage("Resolve failed submissions in Device & Submission Diagnostics."),
				color: "error",
				timeout: 8000,
				loading: false,
			});
			return false;
		}

		toastStore.show({
			key: `shift-close-finalization::${openingShift}`,
			title: translateMessage("Recent sales are still processing"),
			detail: translateMessage(
				"Keep the POS online and try closing the shift again in a few seconds.",
			),
			color: "warning",
			timeout: 8000,
			loading: false,
		});
		return false;
	}

	function applyRegisterData(data: any) {
		if (!data) {
			return;
		}
		pos_profile.value = data.pos_profile;
		pos_opening_shift.value = data.pos_opening_shift;
		uiStore.setRegisterData(data);
		setBootstrapSnapshot(
			createBootstrapSnapshotFromRegisterData(
				data,
				getBootstrapSnapshot(),
				{ buildVersion },
			),
		);
		// Refresh optional payment metadata in the background while the terminal is
		// online. The helper is profile-scoped, durable before it reports success,
		// and deliberately performs no RPC when this cached opening is restored
		// offline.
		void warmSalesPersonOptions(data.pos_profile).catch((error) => {
			console.warn("Unable to warm POS sales-person options", error);
		});

		try {
			frappe.realtime.emit("pos_profile_registered");
		} catch (e) {
			console.warn("Realtime emit failed", e);
		}
	}

	async function check_opening_entry() {
		await initPromise;
		if (isOfflineStorageReady()) {
			await checkDbHealth();
		}
		const cachedOpening = getValidCachedOpeningForCurrentUser(
			getOpeningStorage(),
			frappe?.session?.user,
		);
		if (cachedOpening) {
			applyRegisterData(cachedOpening);
			console.info("LoadPosProfile (bootstrapped from cache)");
		}
		return frappe
			.call("posawesome.posawesome.api.shifts.check_opening_shift", {
				user: frappe.session.user,
			})
			.then((r: any) => {
				if (r.message) {
					applyRegisterData(r.message);
					if (pos_profile.value.taxes_and_charges) {
						frappe.call({
							method: "frappe.client.get",
							args: {
								doctype: "Sales Taxes and Charges Template",
								name: pos_profile.value.taxes_and_charges,
							},
							callback: (res: any) => {
								if (res.message) {
									setTaxTemplate(
										pos_profile.value.taxes_and_charges,
										res.message,
									);
								}
							},
						});
					}
					console.info("LoadPosProfile");
					try {
						setOpeningStorage(r.message);
					} catch (e) {
						console.error("Failed to cache opening data", e);
					}
				} else {
					console.info("No opening shift found, opening dialog");
					clearOpeningStorage();
					openDialog && openDialog();
				}
			})
			.catch((err: unknown) => {
				console.error("Error checking opening entry", err);
				const data = cachedOpening ||
					getValidCachedOpeningForCurrentUser(
						getOpeningStorage(),
						frappe?.session?.user,
					);
				if (data) {
					applyRegisterData(data);
					console.info("LoadPosProfile (cached)");
					return;
				}
				if (!isOffline()) {
					clearOpeningStorage();
				}
				openDialog && openDialog();
			});
	}

	async function get_closing_data() {
		const cachedOpeningShift = (getOpeningStorage() as any)
			?.pos_opening_shift;
		const resolvedShift =
			uiStore.posOpeningShift ||
			pos_opening_shift.value ||
			cachedOpeningShift ||
			null;
		if (!resolvedShift) {
			return Promise.resolve();
		}
		const openingName = String(resolvedShift.name || "").trim();
		if (!openingName || !(await waitForClosingSubmissionsWithToast(openingName))) {
			return;
		}
		return frappe
			.call(
				"posawesome.posawesome.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening",
				{ opening_shift: resolvedShift },
			)
			.then((r: any) => {
				if (r.message) {
					const response = normalizeClosingShiftPreparationResponse(r.message);
					const closingShift = response.closing_shift;
					const skippedPrintedInvoices = Array.isArray(response.skipped_printed_invoices)
						? response.skipped_printed_invoices
						: [];
					if (!closingShift) {
						return;
					}

					if (skippedPrintedInvoices.length) {
						const confirmed = window.confirm(
							buildSkippedClosingInvoicesPrompt(skippedPrintedInvoices),
						);
						if (!confirmed) {
							return;
						}
					}

					eventBus?.emit("open_ClosingDialog", closingShift);
				}
			});
	}

	async function submit_closing_pos(data: any) {
		console.log("Submitting closing shift", data);
		const openingName = String(data?.pos_opening_shift || "").trim();
		if (openingName && !(await waitForClosingSubmissionsWithToast(openingName))) {
			return;
		}
		return frappe
			.call(
				"posawesome.posawesome.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift",
				{
					closing_shift: JSON.stringify(data),
				},
			)
			.then((r: any) => {
				console.log("Submit result", r);
				if (r.message) {
					pos_profile.value = null;
					pos_opening_shift.value = null;
					uiStore.posOpeningShift = null;
					clearOpeningStorage();
					useInvoiceStore().clear();
					toastStore.show({
						title: "POS Shift Closed",
						color: "success",
					});
					check_opening_entry();
				}
			})
			.catch((err: unknown) => {
				console.error("Failed to submit closing shift", err);
			});
	}

	return {
		pos_profile,
		pos_opening_shift,
		check_opening_entry,
		get_closing_data,
		submit_closing_pos,
	};
}
