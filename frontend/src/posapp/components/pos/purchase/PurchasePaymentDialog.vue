<template>
	<v-dialog v-model="dialog" max-width="600px" persistent>
		<v-card
			ref="paymentDialogRoot"
			class="pos-themed-card purchase-payment-dialog"
			style="max-height: 80vh; overflow: hidden"
			data-pos-keyboard-root
			@keydown.capture="handlePaymentKeydown"
		>
			<v-card-title class="bg-primary text-white d-flex align-center py-3">
				<span class="text-h6">{{ __("Payment") }}</span>
				<v-spacer></v-spacer>
				<span class="text-subtitle-1 font-weight-bold">
					{{ formatCurrency(totalAmount, currency) }}
				</span>
			</v-card-title>

			<v-card-text class="pa-0 overflow-y-auto" style="max-height: 60vh">
				<section class="purchase-payment-source pa-3">
					<div class="text-subtitle-2 mb-2">{{ __("Payment source") }}</div>
					<v-btn-toggle v-model="paymentSource" mandatory color="primary" class="w-100">
						<v-btn value="drawer" class="flex-grow-1" prepend-icon="mdi-cash-register">
							{{ __("POS Drawer") }}
						</v-btn>
						<v-btn value="account" class="flex-grow-1" prepend-icon="mdi-bank-outline">
							{{ __("ERP Account") }}
						</v-btn>
					</v-btn-toggle>
					<div class="text-caption text-medium-emphasis mt-2">
						{{
							paymentSource === "drawer"
								? __("Included as cash-out in this terminal's shift closing.")
								: __("Posted in ERPNext without changing the POS drawer balance.")
						}}
					</div>
				</section>

				<v-divider class="mx-3" />

				<!-- Payment Summary -->
				<v-row v-if="totalAmount > 0" class="pa-3 ma-0" dense>
					<v-col cols="6">
						<v-text-field
							variant="solo"
							color="primary"
							:label="frappe._('Paid Amount')"
							class="sleek-field pos-themed-input"
							hide-details
							:model-value="formatCurrency(paidAmount, currency)"
							readonly
							:prefix="currencySymbol(currency)"
							density="compact"
						></v-text-field>
					</v-col>
					<v-col cols="6">
						<v-text-field
							variant="solo"
							color="primary"
							:label="remainingAmount > 0 ? __('To Be Paid') : __('Change')"
							class="sleek-field pos-themed-input"
							hide-details
							:model-value="formatCurrency(Math.abs(remainingAmount), currency)"
							:prefix="currencySymbol(currency)"
							density="compact"
							readonly
							:class="remainingAmount > 0 ? 'text-error' : 'text-success'"
						></v-text-field>
					</v-col>
				</v-row>

				<v-divider class="mx-3"></v-divider>

				<!-- Payment Inputs -->
				<div class="pa-3">
					<v-row
						v-for="(payment, index) in paymentLines"
						:key="payment.mode_of_payment"
						class="payments pa-1 ma-0 align-center"
						dense
					>
						<v-col cols="6">
							<v-text-field
								density="compact"
								variant="solo"
								color="primary"
								:label="frappe._(payment.mode_of_payment)"
								class="sleek-field pos-themed-input"
								hide-details
								:model-value="formatCurrency(payment.amount, currency)"
								@change="handlePaymentAmountChange(payment, $event)"
								:prefix="currencySymbol(currency)"
								@focus="set_rest_amount(payment)"
								inputmode="decimal"
							></v-text-field>
						</v-col>
						<v-col cols="6">
							<v-btn
								block
								color="primary"
								theme="dark"
								class="payment-method-btn"
								@click="set_full_amount(payment)"
								size="small"
							>
								{{ payment.mode_of_payment }}
							</v-btn>
						</v-col>

						<!-- Cash Denomination Buttons -->
						<v-col
							cols="12"
							v-if="isCashLikePayment(payment) && getVisibleDenominations(payment).length"
							class="py-0 px-2 mt-2 mb-2"
						>
							<div class="d-flex flex-wrap gap-2">
								<v-btn
									v-for="d in getVisibleDenominations(payment)"
									:key="d"
									size="x-small"
									class="mr-1 mb-1"
									color="secondary"
									variant="tonal"
									@click="setPaymentToDenomination(payment, d)"
								>
									{{ formatCurrency(d, currency) }}
								</v-btn>
							</div>
						</v-col>
					</v-row>
				</div>

				<v-divider class="mx-3"></v-divider>

				<!-- Invoice Totals -->
				<v-row class="pa-3 ma-0" dense>
					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="solo"
							color="primary"
							:label="frappe._('Net Total')"
							class="sleek-field pos-themed-input"
							:model-value="formatCurrency(totalAmount, currency)"
							readonly
							:prefix="currencySymbol(currency)"
							hide-details
						></v-text-field>
					</v-col>
					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="solo"
							color="primary"
							:label="frappe._('Total Amount')"
							class="sleek-field pos-themed-input"
							hide-details
							:model-value="formatCurrency(totalAmount, currency)"
							readonly
							:prefix="currencySymbol(currency)"
						></v-text-field>
					</v-col>
				</v-row>
			</v-card-text>

			<v-card-actions class="pa-4 border-t bg-surface">
				<v-row align="start" no-gutters class="w-100">
					<v-col cols="12">
						<v-btn
							block
							size="large"
							color="primary"
							theme="dark"
							class="submit-btn"
							@click="submit"
							:loading="loading"
							:disabled="loading || !isPaymentValid"
						>
							{{ __("Continue to Authorization") }}
						</v-btn>
					</v-col>
					<v-col cols="12" class="mt-2">
						<v-btn
							block
							size="large"
							color="error"
							theme="dark"
							variant="outlined"
							@click="close"
						>
							{{ __("Cancel Payment") }}
						</v-btn>
					</v-col>
				</v-row>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { formatUtils } from "../../../format";
import { getSmartTenderSuggestions } from "../../../../utils/smartTender";
import { focusFirstKeyboardTarget, moveFocusByArrow } from "../../../utils/keyboardNavigation";

defineOptions({
	name: "PurchasePaymentDialog",
});

const __ = window.__ || ((text) => text);

const props = defineProps({
	modelValue: Boolean,
	totalAmount: {
		type: Number,
		required: true,
	},
	currency: {
		type: String,
		default: "",
	},
	posProfile: {
		type: Object,
		required: true,
	},
});

const emit = defineEmits(["update:modelValue", "submit"]);
const currency_precision = ref(2);

const paymentLines = ref([]);
const loading = ref(false);
const paymentDialogRoot = ref(null);
const paymentSource = ref("drawer");

const dialog = computed({
	get() {
		return props.modelValue;
	},
	set(val) {
		emit("update:modelValue", val);
	},
});

const paidAmount = computed(() =>
	paymentLines.value.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0),
);

const remainingAmount = computed(() => props.totalAmount - paidAmount.value);

const isPaymentValid = computed(() => {
	const hasNegativePayment = paymentLines.value.some((p) => (parseFloat(p.amount) || 0) < 0);
	if (hasNegativePayment) return false;
	return paidAmount.value > 0 && Math.abs(remainingAmount.value) <= 0.01;
});

watch(
	() => props.modelValue,
	async (val) => {
		if (val) {
			paymentSource.value = "drawer";
			await initializePayments();
			if (!props.modelValue) return;
			loading.value = false;
			nextTick(() => focusFirstKeyboardTarget(paymentDialogRoot.value, "input:not([readonly])"));
		}
	},
);

function handlePaymentKeydown(event) {
	if (event.key === "Escape" && !loading.value) {
		event.preventDefault();
		close();
		return;
	}
	moveFocusByArrow(event, { root: paymentDialogRoot.value });
}

const flt = (value, precision, number_format, rounding_method) => {
	if (!precision && precision != 0) {
		precision = currency_precision.value || 2;
	}
	if (!rounding_method) {
		rounding_method = "Banker's Rounding (legacy)";
	}
	return window.flt(value, precision, number_format, rounding_method);
};

function formatCurrency(value, precision) {
	if (value === null || value === undefined) {
		value = 0;
	}
	let number = Number(formatUtils.fromArabicNumerals(String(value)).replace(/,/g, ""));
	if (isNaN(number)) number = 0;
	let prec = precision != null ? Number(precision) : Number(currency_precision.value) || 2;
	if (!Number.isInteger(prec) || prec < 0 || prec > 20) {
		prec = Math.min(Math.max(parseInt(prec) || 2, 0), 20);
	}

	const locale = formatUtils.getNumberLocale();
	let formatted = number.toLocaleString(locale, {
		minimumFractionDigits: prec,
		maximumFractionDigits: prec,
		useGrouping: true,
	});

	formatted = formatUtils.toArabicNumerals(formatted);
	return formatted;
}

async function initializePayments() {
	let modes = Array.isArray(props.posProfile.payments)
		? props.posProfile.payments.filter((row) => row?.mode_of_payment)
		: [];
	if (!modes.length) {
		try {
			const { message } = await frappe.call({
				method: "posawesome.posawesome.api.purchase_orders.get_purchase_payment_methods",
				args: {
					pos_profile: props.posProfile.name || null,
					company: props.posProfile.company,
				},
			});
			modes = message || [];
		} catch (error) {
			console.error("Failed to load purchase payment methods", error);
		}
	}
	paymentLines.value = modes.map((m) => ({
		mode_of_payment: m.mode_of_payment,
		amount: 0,
		default: m.default,
		type: m.type,
	}));

	// Auto-fill default payment method if exists
	const defaultMode = paymentLines.value.find((p) => p.default) || paymentLines.value[0];
	if (defaultMode) {
		defaultMode.amount = props.totalAmount;
	}
}

function set_full_amount(payment) {
	// Reset all other payments
	paymentLines.value.forEach((p) => {
		if (p !== payment) {
			p.amount = 0;
		}
	});
	// Set this payment to total amount
	payment.amount = props.totalAmount;
}

function set_rest_amount(payment) {
	// If payment is 0 and there's remaining amount, auto-fill
	if (payment.amount === 0 && remainingAmount.value > 0) {
		payment.amount = remainingAmount.value;
	}
}

function handlePaymentAmountChange(payment, event) {
	const val = parseFloat(event) || 0;
	payment.amount = val;

	// Auto-balance: if this payment exceeds remaining, reduce others
	if (remainingAmount.value < 0) {
		autoBalancePayments(payment);
	}
}

function setPaymentToDenomination(payment, amount) {
	payment.amount = amount;
	// Auto-balance other payments if needed
	if (remainingAmount.value < 0) {
		autoBalancePayments(payment);
	}
}

function autoBalancePayments(excludePayment) {
	const excess = Math.abs(remainingAmount.value);
	if (excess <= 0) return;

	// Find other payments with amount > 0 to reduce
	const otherPayments = paymentLines.value.filter((p) => p !== excludePayment && parseFloat(p.amount) > 0);

	// Sort by amount descending to reduce larger chunks first
	otherPayments.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));

	let remainingExcess = excess;

	for (const other of otherPayments) {
		if (remainingExcess <= 0) break;

		const otherAmount = parseFloat(other.amount) || 0;
		const reduction = Math.min(otherAmount, remainingExcess);

		other.amount = flt(otherAmount - reduction, currency_precision.value);
		remainingExcess = flt(remainingExcess - reduction, currency_precision.value);
	}
}

function isCashLikePayment(payment) {
	if (!payment) return false;

	// Check if it's the configured cash MOP or contains "cash" in name
	const configuredCashMOP = String(props.posProfile?.posa_cash_mode_of_payment || "").toLowerCase();
	const mode = String(payment.mode_of_payment || "").toLowerCase();
	const type = String(payment.type || "").toLowerCase();

	if (type === "cash") return true;
	if (configuredCashMOP && mode === configuredCashMOP) return true;
	return mode.includes("cash");
}

function getVisibleDenominations(payment) {
	if (!isCashLikePayment(payment)) return [];

	const currentTotalPaid = paidAmount.value;
	const currentPaymentAmount = parseFloat(payment.amount) || 0;
	const otherPayments = currentTotalPaid - currentPaymentAmount;
	const amountToPay = props.totalAmount - otherPayments;

	if (amountToPay <= 0) return [];

	return getSmartTenderSuggestions(amountToPay, props.currency);
}

function currencySymbol(curr) {
	return curr || "";
}

function close() {
	dialog.value = false;
}

function submit() {
	loading.value = true;
	const payments = paymentLines.value
		.filter((p) => p.amount > 0)
		.map((p) => ({
			mode_of_payment: p.mode_of_payment,
			amount: p.amount,
		}));

	emit("submit", {
		payments,
		payment_source: paymentSource.value,
	});
}
</script>

<style scoped>
.v-text-field {
	composes: pos-form-field;
}

/* Remove readonly styling */
.v-text-field--readonly {
	cursor: text;
}

.v-text-field--readonly:hover {
	background-color: transparent;
}

.cards {
	background-color: var(--surface-secondary) !important;
}

.pos-themed-card {
	border-radius: 12px;
}

/* Payment method button styling - matches Payments.vue */
.payment-method-btn {
	position: relative;
	text-transform: none;
	font-weight: 500;
}

.payment-method-btn:hover,
.payment-method-btn:focus,
.payment-method-btn:focus-visible,
.payment-method-btn:active {
	background-color: rgb(var(--v-theme-primary)) !important;
	color: rgb(var(--v-theme-on-primary)) !important;
	box-shadow: none;
}

.payment-method-btn::before,
.payment-method-btn:hover::before,
.payment-method-btn:focus::before,
.payment-method-btn:focus-visible::before,
.payment-method-btn:active::before {
	opacity: 0 !important;
}

/* Submit button styling - matches Payments.vue */
.submit-btn {
	position: relative;
}

.submit-btn:hover,
.submit-btn:focus,
.submit-btn:focus-visible,
.submit-btn:active {
	background-color: rgb(var(--v-theme-primary)) !important;
	color: rgb(var(--v-theme-on-primary)) !important;
	box-shadow: none;
}

.submit-btn:focus-visible {
	outline: 2px solid rgb(var(--v-theme-primary));
	outline-offset: 2px;
}

.submit-btn::before,
.submit-btn:hover::before,
.submit-btn:focus::before,
.submit-btn:focus-visible::before,
.submit-btn:active::before {
	opacity: 0 !important;
}

.submit-highlight {
	box-shadow: 0 0 0 4px rgb(var(--v-theme-primary));
	transition: box-shadow 0.3s ease-in-out;
}

/* Sleek field styling for right-aligned text */
.sleek-field :deep(.v-field__input) {
	text-align: right;
}

/* Payment row spacing */
.payments {
	margin-bottom: 8px;
}

/* Denomination buttons container */
.d-flex.flex-wrap {
	display: flex;
	flex-wrap: wrap;
}

.gap-2 {
	gap: 8px;
}

/* Dialog specific adjustments */
.v-dialog .v-card-text {
	scrollbar-width: thin;
	scrollbar-color: var(--v-theme-primary) transparent;
}

.v-dialog .v-card-text::-webkit-scrollbar {
	width: 6px;
}

.v-dialog .v-card-text::-webkit-scrollbar-track {
	background: transparent;
}

.v-dialog .v-card-text::-webkit-scrollbar-thumb {
	background-color: rgb(var(--v-theme-primary));
	border-radius: 3px;
}
</style>
