<template>
	<v-dialog
		:model-value="modelValue"
		max-width="900px"
		persistent
		content-class="cashier-sale-signing-dialog"
		@update:model-value="handleModelUpdate"
		@after-enter="focusPinInput"
	>
		<v-card
			class="cashier-sale-signing-card"
			data-testid="cashier-sale-signing-dialog"
			@keydown="handleDialogKeydown"
		>
			<v-card-title class="cashier-sale-signing-card__header">
				<div class="cashier-sale-signing-card__brand">
					<v-icon icon="mdi-storefront-outline" size="34" aria-hidden="true" />
					<span>RetailMind-POS</span>
				</div>
				<div class="cashier-sale-signing-card__heading">
					<div class="cashier-sale-signing-card__eyebrow">
						{{ __("Cashier Signature") }}
					</div>
					<div class="cashier-sale-signing-card__title">
						{{ __("Submit Sale") }}
					</div>
				</div>
				<v-btn
					icon="mdi-close"
					variant="text"
					class="cashier-sale-signing-card__close"
					:aria-label="__('Cancel')"
					:disabled="loading"
					@click="cancel"
				/>
			</v-card-title>

			<v-card-text class="cashier-sale-signing-card__body">
				<div class="cashier-sale-signing-card__customer-total">
					<div class="cashier-sale-signing-card__customer">
						<v-icon icon="mdi-account-outline" aria-hidden="true" />
						<strong>{{ customerName || __("Walk-in Customer") }}</strong>
					</div>
					<div class="cashier-sale-signing-card__total">
						<span>{{ __("Total") }}</span>
						<strong>{{ formattedAmount }}</strong>
					</div>
				</div>

				<div
					class="cashier-sale-signing-card__settlement"
					role="radiogroup"
					:aria-label="__('Settlement type')"
				>
					<button
						type="button"
						class="cashier-sale-signing-card__settlement-option"
						:class="{
							'cashier-sale-signing-card__settlement-option--active':
								settlementMode === 'pay',
						}"
						role="radio"
						:aria-checked="settlementMode === 'pay'"
						data-testid="cashier-sale-pay-in-full"
						:disabled="loading"
						@click="selectSettlement('pay')"
					>
						<v-icon icon="mdi-credit-card-outline" aria-hidden="true" />
						{{ __("Pay in full") }}
					</button>
					<button
						type="button"
						class="cashier-sale-signing-card__settlement-option"
						:class="{
							'cashier-sale-signing-card__settlement-option--active':
								settlementMode === 'credit',
						}"
						role="radio"
						:aria-checked="settlementMode === 'credit'"
						data-testid="cashier-sale-credit"
						:disabled="loading || !creditEligible"
						@click="selectSettlement('credit')"
					>
						<v-icon icon="mdi-wallet-outline" aria-hidden="true" />
						{{ __("Credit sale") }}
					</button>
				</div>

				<p
					class="cashier-sale-signing-card__helper"
					:class="{ 'cashier-sale-signing-card__helper--warning': !creditEligible }"
					data-testid="cashier-sale-credit-helper"
				>
					{{ creditHelper }}
				</p>

				<div v-if="settlementMode === 'credit'" class="cashier-sale-signing-card__credit-panel">
					<div class="cashier-sale-signing-card__credit-fields">
						<label>
							<span>{{ __("Amount received now") }}</span>
							<div class="cashier-sale-signing-card__money-input">
								<small>{{ currency }}</small>
								<input
									v-model="receivedAmountInput"
									type="number"
									min="0"
									:max="absoluteAmount"
									step="0.01"
									inputmode="decimal"
									data-testid="cashier-sale-received-amount"
									:disabled="loading"
									@input="validateReceivedAmount"
								/>
							</div>
						</label>
						<label>
							<span>{{ __("Due date (optional)") }}</span>
							<input
								v-model="dueDate"
								type="date"
								:min="postingDate || undefined"
								data-testid="cashier-sale-due-date"
								:disabled="loading"
							/>
						</label>
					</div>

					<div class="cashier-sale-signing-card__credit-summary">
						<div>
							<span>{{ __("Balance on credit") }}</span>
							<strong>{{ formatMoney(creditBalance) }}</strong>
						</div>
						<div>
							<span>{{ __("Current outstanding") }}</span>
							<strong>{{ formatMoney(currentOutstanding) }}</strong>
						</div>
						<div>
							<span>{{ __("Projected outstanding") }}</span>
							<strong :class="{ 'cashier-sale-signing-card__danger': limitExceeded }">
								{{ formatMoney(projectedOutstanding) }}
							</strong>
						</div>
						<div>
							<span>{{ __("Credit limit") }}</span>
							<strong>
								{{ configuredLimit > 0 ? formatMoney(configuredLimit) : __("Not configured") }}
							</strong>
						</div>
					</div>
					<p v-if="receivedAmountError || limitExceeded" class="cashier-sale-signing-card__error">
						{{
							receivedAmountError ||
							__("This sale would exceed the customer's configured credit limit.")
						}}
					</p>
				</div>

				<v-text-field
					ref="pinInput"
					v-model="cashierPin"
					:label="__('Cashier PIN')"
					:type="showPin ? 'text' : 'password'"
					inputmode="numeric"
					autocomplete="off"
					variant="outlined"
					density="comfortable"
					class="cashier-sale-signing-card__pin"
					data-testid="cashier-sale-pin-input"
					:disabled="loading"
					:error-messages="pinError"
					:append-inner-icon="showPin ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
					@click:append-inner="showPin = !showPin"
					@keydown.enter.prevent="submit"
					@keydown.down.prevent="selectNextPayment"
					@keydown.up.prevent="selectPreviousPayment"
				/>

				<div
					v-if="settlementMode === 'pay' || receivedAmount > 0"
					class="cashier-sale-signing-card__payment-section"
				>
					<div class="cashier-sale-signing-card__method-label">
						{{ settlementMode === "credit" ? __("Payment method for amount received") : __("Payment Method") }}
					</div>
					<div
						class="cashier-sale-signing-card__methods"
						role="radiogroup"
						:aria-label="__('Payment Method')"
					>
						<button
							v-for="(payment, index) in normalizedPayments"
							:key="payment.mode_of_payment"
							type="button"
							class="cashier-sale-signing-card__method"
							:class="{
								'cashier-sale-signing-card__method--active':
									selectedMode === payment.mode_of_payment,
							}"
							:disabled="loading"
							:aria-checked="selectedMode === payment.mode_of_payment"
							role="radio"
							data-testid="cashier-sale-payment-method"
							@click="selectedMode = payment.mode_of_payment"
							@keydown.enter.prevent="submit"
							@keydown.space.prevent="selectedMode = payment.mode_of_payment"
							@keydown.down.prevent="selectNextPayment"
							@keydown.up.prevent="selectPreviousPayment"
						>
							<small class="cashier-sale-signing-card__method-key">{{ index + 1 }}</small>
							<v-icon :icon="payment.icon" size="30" aria-hidden="true" />
							<strong>{{ payment.mode_of_payment }}</strong>
						</button>
					</div>
				</div>
			</v-card-text>

			<v-card-actions class="cashier-sale-signing-card__actions">
				<v-btn
					variant="flat"
					color="grey-lighten-2"
					:disabled="loading"
					data-testid="cashier-sale-cancel"
					@click="cancel"
				>
					{{ __("Cancel") }}
				</v-btn>
				<v-btn
					variant="flat"
					color="success"
					:loading="loading"
					:disabled="!canSubmit"
					data-testid="cashier-sale-submit"
					@click="submit"
				>
					{{ settlementMode === "credit" ? __("Authorize Credit Sale") : __("Submit Sale") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";

const props = defineProps({
	modelValue: { type: Boolean, default: false },
	payments: { type: Array, default: () => [] },
	amount: { type: Number, default: 0 },
	currency: { type: String, default: "" },
	formatCurrency: { type: Function, default: null },
	loading: { type: Boolean, default: false },
	preferredMode: { type: String, default: "" },
	customerName: { type: String, default: "" },
	creditEligible: { type: Boolean, default: false },
	creditReason: { type: String, default: "" },
	creditContext: { type: Object, default: () => ({}) },
	creditContextLoading: { type: Boolean, default: false },
	initialCreditSale: { type: Boolean, default: false },
	initialReceivedAmount: { type: Number, default: 0 },
	initialDueDate: { type: String, default: "" },
	postingDate: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "submit", "cancel"]);
const __ = window.__ || ((value) => value);
const cashierPin = ref("");
const selectedMode = ref("");
const settlementMode = ref("pay");
const receivedAmountInput = ref("0");
const dueDate = ref("");
const pinError = ref("");
const receivedAmountError = ref("");
const pinInput = ref(null);
const showPin = ref(false);

const absoluteAmount = computed(() => Math.abs(Number(props.amount) || 0));
const receivedAmount = computed(() => {
	const value = Number(receivedAmountInput.value);
	return Number.isFinite(value) ? Math.max(value, 0) : 0;
});
const creditBalance = computed(() => Math.max(absoluteAmount.value - receivedAmount.value, 0));
const currentOutstanding = computed(() => Number(props.creditContext?.current_outstanding) || 0);
const configuredLimit = computed(() => Number(props.creditContext?.configured_limit) || 0);
const projectedOutstanding = computed(() => currentOutstanding.value + creditBalance.value);
const limitExceeded = computed(
	() => configuredLimit.value > 0 && projectedOutstanding.value > configuredLimit.value + 0.001,
);

const iconForPayment = (payment) => {
	const value = `${payment?.type || ""} ${payment?.mode_of_payment || ""}`.toLowerCase();
	if (value.includes("cash")) return "mdi-cash-multiple";
	if (value.includes("cheque") || value.includes("check")) return "mdi-checkbook";
	if (value.includes("wire") || value.includes("transfer")) return "mdi-swap-horizontal";
	if (value.includes("bank")) return "mdi-bank-outline";
	return "mdi-credit-card-outline";
};

const normalizedPayments = computed(() => {
	const seen = new Set();
	return (Array.isArray(props.payments) ? props.payments : [])
		.map((payment) => ({
			mode_of_payment: String(payment?.mode_of_payment || "").trim(),
			type: String(payment?.type || "").trim(),
			default: payment?.default,
			icon: iconForPayment(payment),
		}))
		.filter((payment) => {
			if (!payment.mode_of_payment || seen.has(payment.mode_of_payment)) return false;
			seen.add(payment.mode_of_payment);
			return true;
		});
});

const formatMoney = (value) => {
	if (typeof props.formatCurrency === "function") {
		return props.formatCurrency(Math.abs(Number(value) || 0), props.currency);
	}
	return `${props.currency || ""} ${Math.abs(Number(value) || 0).toFixed(2)}`.trim();
};
const formattedAmount = computed(() => formatMoney(absoluteAmount.value));

const reasonMessages = {
	WALK_IN_CUSTOMER: __("Select a named customer to use Credit Sale."),
	CUSTOMER_REQUIRED: __("Select a named customer to use Credit Sale."),
	PROFILE_DISABLED: __("Credit Sale is not enabled for this POS Profile."),
	LIMIT_EXCEEDED: __("The customer's configured credit limit would be exceeded."),
	RETURN_NOT_ALLOWED: __("Returns cannot be submitted as Credit Sales."),
	INCOMPATIBLE_REDEMPTION: __("Remove customer balance or gift card redemption to use Credit Sale."),
	CONTEXT_UNAVAILABLE: __("Customer credit details could not be loaded. Try again."),
};
const creditHelper = computed(() => {
	if (props.creditContextLoading) return __("Checking customer credit eligibility…");
	if (props.creditEligible) {
		return __("Credit sale is available for this named customer. Blank due date means due today.");
	}
	return reasonMessages[props.creditReason] || __("Credit sale is available for eligible named customers.");
});

const canSubmit = computed(() => {
	if (!cashierPin.value.trim() || props.loading) return false;
	if (settlementMode.value === "pay") return Boolean(selectedMode.value);
	if (
		!props.creditEligible ||
		props.creditContextLoading ||
		creditBalance.value <= 0.001 ||
		limitExceeded.value
	) {
		return false;
	}
	if (receivedAmountError.value) return false;
	return receivedAmount.value <= 0.001 || Boolean(selectedMode.value);
});

const selectPreferredMode = () => {
	const payments = normalizedPayments.value;
	if (!payments.length) {
		selectedMode.value = "";
		return;
	}
	const preferred = String(props.preferredMode || "").trim();
	selectedMode.value =
		payments.find((payment) => payment.mode_of_payment === preferred)?.mode_of_payment ||
		payments.find((payment) => payment.default === 1 || payment.default === true)?.mode_of_payment ||
		payments[0].mode_of_payment;
};

const selectSettlement = (mode) => {
	if (mode === "credit" && !props.creditEligible) return;
	settlementMode.value = mode;
	pinError.value = "";
	if (mode === "pay") {
		receivedAmountInput.value = String(absoluteAmount.value);
	} else if (receivedAmount.value >= absoluteAmount.value) {
		receivedAmountInput.value = "0";
	}
};

const validateReceivedAmount = () => {
	const rawValue = Number(receivedAmountInput.value);
	if (!Number.isFinite(rawValue) || rawValue < 0) {
		receivedAmountError.value = __("Amount received cannot be negative.");
		return;
	}
	if (rawValue > absoluteAmount.value) {
		receivedAmountError.value = __("Amount received cannot exceed the sale total.");
		return;
	}
	receivedAmountError.value = "";
};

const selectRelativePayment = (delta) => {
	const payments = normalizedPayments.value;
	if (!payments.length) return;
	const currentIndex = Math.max(
		0,
		payments.findIndex((payment) => payment.mode_of_payment === selectedMode.value),
	);
	selectedMode.value = payments[(currentIndex + delta + payments.length) % payments.length].mode_of_payment;
};
const selectNextPayment = () => selectRelativePayment(1);
const selectPreviousPayment = () => selectRelativePayment(-1);

const reset = () => {
	cashierPin.value = "";
	pinError.value = "";
	receivedAmountError.value = "";
	showPin.value = false;
	dueDate.value = props.initialDueDate || "";
	receivedAmountInput.value = String(Math.max(Number(props.initialReceivedAmount) || 0, 0));
	settlementMode.value = props.initialCreditSale && props.creditEligible ? "credit" : "pay";
	if (settlementMode.value === "pay") {
		receivedAmountInput.value = String(absoluteAmount.value);
	}
	selectPreferredMode();
};

const focusPinInput = () => {
	const input = pinInput.value?.$el?.querySelector?.("input");
	input?.focus?.();
};
const cancel = () => {
	emit("cancel");
	emit("update:modelValue", false);
};

const submit = () => {
	const pin = cashierPin.value.trim();
	if (!pin) {
		pinError.value = __("Cashier PIN is required");
		return;
	}
	validateReceivedAmount();
	if (!canSubmit.value) {
		if (settlementMode.value === "pay" && !selectedMode.value) {
			pinError.value = __("Select a payment method");
		}
		return;
	}
	emit("submit", {
		cashierPin: pin,
		modeOfPayment: selectedMode.value,
		settlementMode: settlementMode.value,
		receivedAmount: settlementMode.value === "credit" ? receivedAmount.value : absoluteAmount.value,
		dueDate: settlementMode.value === "credit" ? dueDate.value : "",
	});
};

const handleDialogKeydown = (event) => {
	if (event.key === "Escape") {
		event.preventDefault();
		cancel();
		return;
	}
	const isTextEntry = ["INPUT", "TEXTAREA"].includes(event.target?.tagName);
	if (!isTextEntry && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
		event.preventDefault();
		selectSettlement(event.key === "ArrowRight" ? "credit" : "pay");
	}
};
const handleModelUpdate = (value) => {
	if (!value) cancel();
};

watch(
	() => props.modelValue,
	(isOpen) => {
		if (isOpen) {
			reset();
			nextTick(focusPinInput);
		}
	},
);
watch(() => props.preferredMode, selectPreferredMode);
watch(normalizedPayments, selectPreferredMode);
watch(
	() => props.creditEligible,
	(eligible) => {
		if (!eligible && settlementMode.value === "credit") selectSettlement("pay");
	},
);

defineExpose({ submit });
</script>

<style scoped>
.cashier-sale-signing-card {
	border: 2px solid #0b5f5a;
	background: #fff;
	box-shadow: 0 20px 48px rgba(7, 25, 31, 0.3);
}

.cashier-sale-signing-card__header {
	display: grid;
	grid-template-columns: 1fr auto 1fr;
	align-items: center;
	gap: 20px;
	padding: 16px 24px;
	background: #075e59;
	color: #fff;
}

.cashier-sale-signing-card__brand,
.cashier-sale-signing-card__customer,
.cashier-sale-signing-card__total {
	display: flex;
	align-items: center;
	gap: 12px;
}

.cashier-sale-signing-card__brand {
	font-size: 1.3rem;
	font-weight: 800;
}

.cashier-sale-signing-card__heading {
	text-align: left;
}

.cashier-sale-signing-card__eyebrow {
	font-size: 0.72rem;
	font-weight: 800;
	text-transform: uppercase;
	color: #b5ebe6;
}

.cashier-sale-signing-card__title {
	font-size: 1.45rem;
	font-weight: 800;
	line-height: 1.1;
}

.cashier-sale-signing-card__close {
	justify-self: end;
	color: #fff !important;
}

.cashier-sale-signing-card__body {
	padding: 22px 26px 10px;
}

.cashier-sale-signing-card__customer-total {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 18px;
	margin-bottom: 14px;
	padding: 12px 16px;
	border: 1px solid #b8d6d2;
	border-radius: 6px;
	background: #f2f8f7;
	color: #182a2d;
}

.cashier-sale-signing-card__total span {
	color: #526064;
}

.cashier-sale-signing-card__total strong {
	font-size: 1.45rem;
}

.cashier-sale-signing-card__settlement {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
}

.cashier-sale-signing-card__settlement-option {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 10px;
	min-height: 52px;
	border: 1px solid #b8c5c6;
	border-radius: 6px;
	background: #fff;
	color: #202b2e;
	font-weight: 800;
	cursor: pointer;
}

.cashier-sale-signing-card__settlement-option--active {
	border-color: #137a43;
	background: #137a43;
	color: #fff;
}

.cashier-sale-signing-card__settlement-option:disabled {
	cursor: not-allowed;
	opacity: 0.48;
}

.cashier-sale-signing-card__helper {
	margin: 8px 0 14px;
	color: #687477;
	font-size: 0.84rem;
}

.cashier-sale-signing-card__helper--warning {
	color: #9a5a10;
}

.cashier-sale-signing-card__credit-panel {
	margin-bottom: 14px;
	padding: 14px;
	border: 1px solid #d3dfdd;
	border-radius: 6px;
	background: #fbfdfd;
}

.cashier-sale-signing-card__credit-fields,
.cashier-sale-signing-card__credit-summary {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
}

.cashier-sale-signing-card__credit-fields label > span,
.cashier-sale-signing-card__credit-summary span {
	display: block;
	margin-bottom: 5px;
	color: #5b686b;
	font-size: 0.76rem;
	font-weight: 700;
}

.cashier-sale-signing-card__credit-fields input {
	width: 100%;
	height: 42px;
	border: 1px solid #9eadaf;
	border-radius: 4px;
	background: #fff;
	padding: 0 10px;
	color: #182a2d;
}

.cashier-sale-signing-card__money-input {
	display: flex;
	align-items: center;
	border: 1px solid #9eadaf;
	border-radius: 4px;
	background: #fff;
}

.cashier-sale-signing-card__money-input small {
	padding-left: 10px;
	color: #5b686b;
}

.cashier-sale-signing-card__money-input input {
	border: 0;
}

.cashier-sale-signing-card__credit-summary {
	margin-top: 12px;
	padding-top: 12px;
	border-top: 1px solid #dbe4e3;
}

.cashier-sale-signing-card__credit-summary strong {
	color: #173a32;
}

.cashier-sale-signing-card__danger,
.cashier-sale-signing-card__error {
	color: #b42318 !important;
}

.cashier-sale-signing-card__error {
	margin: 10px 0 0;
	font-size: 0.82rem;
	font-weight: 700;
}

.cashier-sale-signing-card__pin {
	margin-bottom: 12px;
}

.cashier-sale-signing-card__method-label {
	margin-bottom: 8px;
	color: #173044;
	font-size: 0.82rem;
	font-weight: 800;
	text-transform: uppercase;
}

.cashier-sale-signing-card__methods {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 10px;
}

.cashier-sale-signing-card__method {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	min-height: 104px;
	border: 1px solid #c7d0d1;
	border-radius: 6px;
	background: #fff;
	color: #152329;
	font-weight: 800;
	cursor: pointer;
}

.cashier-sale-signing-card__method-key {
	position: absolute;
	top: 8px;
	left: 8px;
	min-width: 24px;
	padding: 2px 5px;
	border: 1px solid currentColor;
	border-radius: 4px;
	text-align: center;
}

.cashier-sale-signing-card__method--active {
	border-color: #087d86;
	background: #087d86;
	color: #fff;
}

.cashier-sale-signing-card__method:focus,
.cashier-sale-signing-card__settlement-option:focus,
.cashier-sale-signing-card__credit-fields input:focus {
	outline: 3px solid #35a8ff;
	outline-offset: 2px;
}

.cashier-sale-signing-card__actions {
	justify-content: flex-end;
	padding: 14px 26px 18px;
	border-top: 1px solid #dce3e3;
	gap: 10px;
}

@media (max-width: 700px) {
	.cashier-sale-signing-card__header {
		grid-template-columns: 1fr auto;
	}

	.cashier-sale-signing-card__heading {
		display: none;
	}

	.cashier-sale-signing-card__customer-total {
		align-items: flex-start;
		flex-direction: column;
	}

	.cashier-sale-signing-card__settlement,
	.cashier-sale-signing-card__credit-fields,
	.cashier-sale-signing-card__credit-summary,
	.cashier-sale-signing-card__methods {
		grid-template-columns: 1fr;
	}
}
</style>
