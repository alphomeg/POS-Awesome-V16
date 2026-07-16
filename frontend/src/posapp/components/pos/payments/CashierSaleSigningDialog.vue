<template>
	<v-dialog
		:model-value="modelValue"
		max-width="640px"
		persistent
		content-class="cashier-sale-signing-dialog"
		:retain-focus="false"
		@update:model-value="handleModelUpdate"
	>
		<v-card class="cashier-sale-signing-card" data-testid="cashier-sale-signing-dialog">
			<v-card-title class="cashier-sale-signing-card__header">
				<div>
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
				<div class="cashier-sale-signing-card__amount">
					<span>{{ __("Total") }}</span>
					<strong>{{ formattedAmount }}</strong>
				</div>

				<v-text-field
					ref="pinInput"
					v-model="cashierPin"
					:label="__('Cashier PIN')"
					type="password"
					inputmode="numeric"
					autocomplete="off"
					variant="outlined"
					density="comfortable"
					class="cashier-sale-signing-card__pin"
					data-testid="cashier-sale-pin-input"
					:disabled="loading"
					:error-messages="pinError"
					@keydown.enter.prevent="submit"
					@keydown.down.prevent="selectNextPayment"
					@keydown.up.prevent="selectPreviousPayment"
				/>

				<div class="cashier-sale-signing-card__method-label">
					{{ __("Payment Method") }}
				</div>
				<div
					class="cashier-sale-signing-card__methods"
					role="radiogroup"
					:aria-label="__('Payment Method')"
				>
					<button
						v-for="payment in normalizedPayments"
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
						<span>{{ payment.mode_of_payment }}</span>
						<small v-if="payment.type">{{ payment.type }}</small>
					</button>
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
					{{ __("Submit Sale") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";

const props = defineProps({
	modelValue: {
		type: Boolean,
		default: false,
	},
	payments: {
		type: Array,
		default: () => [],
	},
	amount: {
		type: Number,
		default: 0,
	},
	currency: {
		type: String,
		default: "",
	},
	formatCurrency: {
		type: Function,
		default: null,
	},
	loading: {
		type: Boolean,
		default: false,
	},
	preferredMode: {
		type: String,
		default: "",
	},
});

const emit = defineEmits(["update:modelValue", "submit", "cancel"]);

const __ = window.__ || ((value) => value);
const cashierPin = ref("");
const selectedMode = ref("");
const pinError = ref("");
const pinInput = ref(null);

const normalizedPayments = computed(() => {
	const seen = new Set();
	return (Array.isArray(props.payments) ? props.payments : [])
		.map((payment) => ({
			mode_of_payment: String(payment?.mode_of_payment || "").trim(),
			type: String(payment?.type || "").trim(),
			default: payment?.default,
		}))
		.filter((payment) => {
			if (!payment.mode_of_payment || seen.has(payment.mode_of_payment)) {
				return false;
			}
			seen.add(payment.mode_of_payment);
			return true;
		});
});

const formattedAmount = computed(() => {
	if (typeof props.formatCurrency === "function") {
		return props.formatCurrency(Math.abs(Number(props.amount) || 0), props.currency);
	}
	return `${props.currency || ""} ${Math.abs(Number(props.amount) || 0).toFixed(2)}`.trim();
});

const canSubmit = computed(
	() => Boolean(cashierPin.value.trim()) && Boolean(selectedMode.value) && !props.loading,
);

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

const selectRelativePayment = (delta) => {
	const payments = normalizedPayments.value;
	if (!payments.length) return;
	const currentIndex = Math.max(
		0,
		payments.findIndex((payment) => payment.mode_of_payment === selectedMode.value),
	);
	const nextIndex = (currentIndex + delta + payments.length) % payments.length;
	selectedMode.value = payments[nextIndex].mode_of_payment;
};

const selectNextPayment = () => selectRelativePayment(1);
const selectPreviousPayment = () => selectRelativePayment(-1);

const reset = () => {
	cashierPin.value = "";
	pinError.value = "";
	selectPreferredMode();
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
	if (!selectedMode.value) {
		pinError.value = __("Select a payment method");
		return;
	}
	emit("submit", {
		cashierPin: pin,
		modeOfPayment: selectedMode.value,
	});
};

const handleModelUpdate = (value) => {
	if (!value) {
		cancel();
	}
};

watch(
	() => props.modelValue,
	(isOpen) => {
		if (isOpen) {
			reset();
			nextTick(() => {
				const input = pinInput.value?.$el?.querySelector?.("input");
				input?.focus?.();
			});
		}
	},
);

watch(() => props.preferredMode, selectPreferredMode);
watch(normalizedPayments, selectPreferredMode);
</script>

<style scoped>
.cashier-sale-signing-card {
	border: 2px solid #0e3a5b;
	background: #ffffff;
	box-shadow: 0 18px 42px rgba(5, 22, 38, 0.28);
}

.cashier-sale-signing-card__header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 16px;
	background: #082f49;
	color: #ffffff;
	padding: 18px 20px;
}

.cashier-sale-signing-card__eyebrow {
	font-size: 0.74rem;
	font-weight: 800;
	text-transform: uppercase;
	color: #7dd3fc;
}

.cashier-sale-signing-card__title {
	font-size: 1.55rem;
	font-weight: 800;
	line-height: 1.15;
}

.cashier-sale-signing-card__close {
	color: #ffffff !important;
}

.cashier-sale-signing-card__body {
	padding: 22px 24px 12px;
}

.cashier-sale-signing-card__amount {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 18px;
	padding: 12px 14px;
	border: 1px solid #9fc4d6;
	background: #e8f5fb;
	color: #0f2c44;
	font-weight: 700;
}

.cashier-sale-signing-card__amount strong {
	font-size: 1.35rem;
}

.cashier-sale-signing-card__pin {
	margin-bottom: 16px;
}

.cashier-sale-signing-card__method-label {
	margin-bottom: 8px;
	color: #0f2c44;
	font-size: 0.82rem;
	font-weight: 800;
	text-transform: uppercase;
}

.cashier-sale-signing-card__methods {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
	gap: 10px;
}

.cashier-sale-signing-card__method {
	min-height: 58px;
	border: 2px solid #9fc4d6;
	background: #f8fafc;
	color: #102a3d;
	font-weight: 800;
	text-align: left;
	padding: 10px 12px;
	cursor: pointer;
}

.cashier-sale-signing-card__method span,
.cashier-sale-signing-card__method small {
	display: block;
}

.cashier-sale-signing-card__method small {
	margin-top: 2px;
	color: #52677a;
	font-size: 0.75rem;
}

.cashier-sale-signing-card__method--active {
	border-color: #0369a1;
	background: #075985;
	color: #ffffff;
}

.cashier-sale-signing-card__method--active small {
	color: #bae6fd;
}

.cashier-sale-signing-card__method:focus {
	outline: 3px solid #38bdf8;
	outline-offset: 2px;
}

.cashier-sale-signing-card__actions {
	padding: 12px 24px 22px;
	gap: 10px;
}
</style>
