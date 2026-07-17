<template>
	<section
		class="counter-grid-transaction-header"
		:class="{
			'counter-grid-transaction-header--no-balance': !showBalance,
			'counter-grid-transaction-header--with-extras': hasExtras,
		}"
		data-testid="counter-grid-transaction-header"
	>
		<div class="counter-grid-transaction-header__primary">
			<div class="counter-grid-context-card counter-grid-context-card--customer">
				<Customer
					ref="customerComponent"
					:pos_profile="posProfile"
					presentation="counter-grid-header"
				/>
			</div>

			<div
				class="counter-grid-context-card counter-grid-context-card--type"
				:title="invoiceModeHint"
				:aria-describedby="invoiceModeHint ? 'counter-grid-invoice-mode-hint' : undefined"
			>
				<v-icon class="counter-grid-context-card__icon" icon="mdi-text-box-outline" size="32" />
				<v-select
					v-if="canSelectInvoiceType"
					:model-value="invoiceType"
					:items="invoiceTypes"
					:label="__('Type')"
					variant="plain"
					density="compact"
					hide-details
					class="counter-grid-context-card__control"
					:disabled="invoiceType === 'Return'"
					@update:model-value="$emit('update:invoiceType', $event)"
				/>
				<div v-else class="counter-grid-context-card__copy">
					<span>{{ __("Type") }}</span>
					<strong>{{ invoiceType || __("Invoice") }}</strong>
				</div>
				<span v-if="invoiceModeHint" id="counter-grid-invoice-mode-hint" class="sr-only">
					{{ invoiceModeHint }}
				</span>
			</div>

			<div class="counter-grid-context-card counter-grid-context-card--date">
				<v-icon class="counter-grid-context-card__icon" icon="mdi-calendar-month-outline" size="32" />
				<div class="counter-grid-context-card__date-control">
					<span class="counter-grid-context-card__label">{{ __("Date") }}</span>
					<VueDatePicker
						v-if="canChangePostingDate"
						ref="postingDatePicker"
						:model-value="postingDateDisplay"
						model-type="format"
						format="dd-MM-yyyy"
						auto-apply
						teleport
						:aria-label="__('Posting Date')"
						class="counter-grid-date-picker"
						@update:model-value="$emit('update:postingDateDisplay', $event)"
					/>
					<strong v-else class="counter-grid-context-card__readonly-value">
						{{ postingDateDisplay }}
					</strong>
				</div>
			</div>

			<div
				v-if="showBalance"
				class="counter-grid-context-card counter-grid-context-card--balance"
				data-testid="counter-grid-customer-balance"
			>
				<span class="counter-grid-context-card__label">{{ __("Customer Balance") }}</span>
				<v-skeleton-loader
					v-if="balanceLoading"
					type="chip"
					width="104"
					class="counter-grid-balance-skeleton"
				/>
				<v-chip
					v-else
					size="small"
					:color="isNegativeBalance ? 'error' : 'success'"
					variant="tonal"
					class="counter-grid-balance-chip"
				>
					<v-icon v-if="isNegativeBalance" start icon="mdi-alert-circle-outline" size="14" />
					{{ formattedBalance }}
				</v-chip>
			</div>

			<div class="counter-grid-total-hero" data-testid="counter-grid-net-total">
				<div class="counter-grid-total-hero__copy">
					<span>{{ __("Net Total") }}</span>
					<strong>{{ formattedNetTotal }}</strong>
				</div>
				<div class="counter-grid-total-hero__watermark" aria-hidden="true">
					<v-icon icon="mdi-receipt-text-outline" size="92" />
					<v-icon icon="mdi-cash" size="38" />
				</div>
			</div>
		</div>

		<div v-if="hasExtras" class="counter-grid-transaction-header__extras">
			<div v-if="showPriceList" class="counter-grid-extra-control">
				<v-select
					:model-value="priceList"
					:items="priceLists"
					:label="__('Price List')"
					prepend-inner-icon="mdi-tag-multiple-outline"
					variant="outlined"
					density="compact"
					hide-details
					@update:model-value="$emit('update:priceList', $event)"
				/>
			</div>
			<slot name="extras" />
		</div>
	</section>
</template>

<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import Customer from "../customer/Customer.vue";
import type { POSProfile } from "../../../types/models";

interface Props {
	posProfile: POSProfile | Record<string, any>;
	invoiceTypes?: string[];
	invoiceType?: string;
	postingDateDisplay?: string;
	customerBalance?: number;
	customerBalanceCurrency?: string;
	balanceLoading?: boolean;
	priceList?: string;
	priceLists?: string[];
	netTotal?: number;
	displayCurrency?: string;
	formatCurrency: (value: number | undefined, currencyOrPrecision?: string | number) => string;
	currencySymbol: (currency?: string) => string;
}

const props = withDefaults(defineProps<Props>(), {
	invoiceTypes: () => ["Invoice", "Order", "Quotation"],
	invoiceType: "Invoice",
	postingDateDisplay: "",
	customerBalance: 0,
	customerBalanceCurrency: undefined,
	balanceLoading: false,
	priceList: "",
	priceLists: () => [],
	netTotal: 0,
	displayCurrency: "",
});

defineEmits<{
	"update:invoiceType": [value: string];
	"update:postingDateDisplay": [value: string];
	"update:priceList": [value: string];
}>();

const __ = window.__ || ((value: string) => value);
const slots = useSlots();
const customerComponent = ref<any>(null);
const postingDatePicker = ref<any>(null);

const canSelectInvoiceType = computed(() => Boolean(props.posProfile?.posa_allow_sales_order));
const canChangePostingDate = computed(() => Boolean(props.posProfile?.posa_allow_change_posting_date));
const showBalance = computed(() => Boolean(props.posProfile?.posa_show_customer_balance));
const showPriceList = computed(() => Boolean(props.posProfile?.posa_enable_price_list_dropdown));
const hasExtras = computed(() => showPriceList.value || Boolean(slots.extras));
const isNegativeBalance = computed(() => Number(props.customerBalance || 0) < 0);
const formattedBalance = computed(() =>
	props.formatCurrency(props.customerBalance, props.customerBalanceCurrency || props.displayCurrency),
);
const formattedNetTotal = computed(
	() => `${props.currencySymbol(props.displayCurrency)}${props.formatCurrency(props.netTotal)}`,
);
const invoiceModeHint = computed(() =>
	props.posProfile?.create_pos_invoice_instead_of_sales_invoice
		? __("Invoices are saved as POS Invoices")
		: "",
);

const focusCustomerSearch = () => customerComponent.value?.focusCustomerSearch?.();
const selectFirstCustomer = () => customerComponent.value?.selectFirstCustomer?.();
const openNewCustomer = () => customerComponent.value?.openNewCustomer?.();
const focusPostingDate = () => {
	if (!canChangePostingDate.value) return;
	const picker = postingDatePicker.value?.$el || postingDatePicker.value;
	const input = picker?.querySelector?.("input");
	input?.focus?.();
	input?.select?.();
};

defineExpose({
	focusCustomerSearch,
	selectFirstCustomer,
	openNewCustomer,
	focusPostingDate,
});
</script>

<style scoped>
.counter-grid-transaction-header {
	display: flex;
	flex: 0 0 auto;
	flex-direction: column;
	gap: 10px;
	min-width: 0;
}

.counter-grid-transaction-header__primary {
	display: grid;
	grid-template-columns: 1.562fr 1.05fr 0.988fr 0.6fr 1.95fr;
	grid-template-areas: "customer type date balance total";
	align-items: start;
	gap: 14px;
	min-width: 0;
	min-height: 146px;
	padding-inline: 12px 10px;
}

.counter-grid-transaction-header--no-balance .counter-grid-transaction-header__primary {
	grid-template-columns: 1.55fr 1.05fr 1fr 2.55fr;
	grid-template-areas: "customer type date total";
}

.counter-grid-context-card {
	display: flex;
	align-items: center;
	min-width: 0;
	height: 98px;
	margin-top: 8px;
	padding: 12px 16px;
	border: 1px solid var(--rm-cg-shell-card-line);
	border-radius: 7px;
	background: var(--rm-cg-surface);
	box-shadow: var(--rm-cg-shell-card-shadow);
}

.counter-grid-context-card--customer {
	grid-area: customer;
	padding: 8px 12px;
}

.counter-grid-context-card--type {
	grid-area: type;
}

.counter-grid-context-card--date {
	grid-area: date;
}

.counter-grid-context-card--balance {
	grid-area: balance;
	align-items: stretch;
	justify-content: center;
	flex-direction: column;
	gap: 8px;
	padding-inline: 14px;
}

.counter-grid-context-card__icon {
	flex: 0 0 auto;
	margin-inline-end: 14px;
	color: var(--rm-cg-shell-icon);
}

.counter-grid-context-card__copy,
.counter-grid-context-card__date-control {
	display: flex;
	flex: 1 1 auto;
	min-width: 0;
	flex-direction: column;
	justify-content: center;
}

.counter-grid-context-card__copy span,
.counter-grid-context-card__label {
	font-size: 0.78rem;
	font-weight: 500;
	line-height: 1.2;
	color: var(--rm-cg-text-muted);
}

.counter-grid-context-card__copy strong,
.counter-grid-context-card__readonly-value {
	overflow: hidden;
	font-size: 1rem;
	font-weight: 500;
	line-height: 1.35;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--rm-cg-text);
}

.counter-grid-context-card__control {
	min-width: 0;
	flex: 1 1 auto;
}

.counter-grid-context-card__control :deep(.v-field) {
	background: transparent !important;
	box-shadow: none !important;
}

.counter-grid-context-card__control :deep(.v-field__overlay) {
	background: transparent !important;
}

.counter-grid-context-card__control :deep(.v-field__input) {
	min-height: 56px;
	padding-inline: 0;
	font-size: 1rem;
}

.counter-grid-context-card__control :deep(.v-label) {
	font-size: 0.78rem;
	color: var(--rm-cg-text-muted) !important;
}

.counter-grid-date-picker {
	width: 100%;
	min-width: 0;
}

.counter-grid-date-picker :deep(.dp__input) {
	width: 100%;
	min-height: 30px;
	padding: 2px 30px 2px 0;
	border: 0;
	border-radius: 0;
	background: transparent;
	box-shadow: none;
	font-family: inherit;
	font-size: 1rem;
	font-weight: 500;
	color: var(--rm-cg-text);
}

.counter-grid-date-picker :deep(.dp__input:focus) {
	outline: 2px solid var(--rm-cg-focus);
	outline-offset: 2px;
}

.counter-grid-date-picker :deep(.dp__input_icon) {
	inset-inline-start: auto;
	inset-inline-end: 0;
	color: var(--rm-cg-text-muted);
}

.counter-grid-date-picker :deep(.dp__input_icon_pad) {
	padding-inline-start: 0;
}

.counter-grid-balance-chip {
	align-self: flex-start;
	max-width: 100%;
	font-size: 0.92rem;
	font-weight: 750;
	font-variant-numeric: tabular-nums;
}

.counter-grid-balance-skeleton :deep(.v-skeleton-loader__chip) {
	height: 28px;
	border-radius: 5px;
}

.counter-grid-total-hero {
	position: relative;
	display: flex;
	grid-area: total;
	align-items: center;
	min-width: 0;
	height: 146px;
	margin-inline-start: 8px;
	padding: 16px 24px;
	overflow: hidden;
	border: 1px solid var(--rm-cg-shell-hero-end);
	border-radius: 7px;
	background: var(--rm-cg-shell-hero-start);
	background: linear-gradient(105deg, var(--rm-cg-shell-hero-start), var(--rm-cg-shell-hero-end));
	box-shadow: 0 3px 8px rgba(4, 50, 40, 0.22);
	color: #ffffff;
}

.counter-grid-total-hero__copy {
	position: relative;
	z-index: 1;
	display: flex;
	min-width: 0;
	flex-direction: column;
}

.counter-grid-total-hero__copy span {
	font-size: 1.18rem;
	font-weight: 750;
	line-height: 1.1;
	text-transform: uppercase;
}

.counter-grid-total-hero__copy strong {
	overflow: hidden;
	font-size: 4.9rem;
	font-weight: 750;
	line-height: 1.05;
	letter-spacing: -0.035em;
	font-variant-numeric: tabular-nums;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.counter-grid-total-hero__watermark {
	position: absolute;
	inset-inline-end: 18px;
	top: 50%;
	width: 100px;
	height: 112px;
	transform: translateY(-50%);
	opacity: 0.1;
}

.counter-grid-total-hero__watermark .v-icon:first-child {
	position: absolute;
	inset: 8px auto auto 0;
}

.counter-grid-total-hero__watermark .v-icon:last-child {
	position: absolute;
	inset: auto 0 14px auto;
}

.counter-grid-transaction-header__extras {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 8px;
	min-width: 0;
	padding: 7px 8px;
	border: 1px solid var(--rm-cg-shell-card-line);
	border-radius: 6px;
	background: var(--rm-cg-surface);
	box-shadow: var(--rm-cg-shell-card-shadow);
}

.counter-grid-extra-control {
	min-width: 0;
}

.counter-grid-extra-control :deep(.v-field) {
	min-height: 42px;
	border-radius: 4px;
}

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

@media (max-width: 1439px), (max-height: 819px) {
	.counter-grid-transaction-header {
		gap: 6px;
	}

	.counter-grid-transaction-header__primary {
		gap: 8px;
		min-height: 112px;
		padding-inline: 0;
	}

	.counter-grid-context-card {
		height: 76px;
		margin-top: 0;
		padding: 7px 10px;
	}

	.counter-grid-context-card--customer {
		padding: 4px 7px;
	}

	.counter-grid-context-card__icon {
		margin-inline-end: 8px;
		font-size: 26px !important;
	}

	.counter-grid-context-card--balance {
		gap: 4px;
		padding-inline: 8px;
	}

	.counter-grid-total-hero {
		height: 112px;
		margin-inline-start: 0;
		padding: 10px 16px;
	}

	.counter-grid-total-hero__copy span {
		font-size: 0.92rem;
	}

	.counter-grid-total-hero__copy strong {
		font-size: 3.35rem;
	}

	.counter-grid-total-hero__watermark {
		inset-inline-end: 8px;
		transform: translateY(-50%) scale(0.8);
	}

	.counter-grid-transaction-header--with-extras .counter-grid-transaction-header__primary {
		min-height: 92px;
	}

	.counter-grid-transaction-header--with-extras .counter-grid-context-card {
		height: 68px;
	}

	.counter-grid-transaction-header--with-extras .counter-grid-total-hero {
		height: 92px;
	}
}

@media (max-width: 1099px) {
	.counter-grid-context-card--date > .counter-grid-context-card__icon {
		display: none;
	}

	.counter-grid-context-card__copy span,
	.counter-grid-context-card__label,
	.counter-grid-context-card__control :deep(.v-label) {
		font-size: 0.68rem;
	}

	.counter-grid-context-card__copy strong,
	.counter-grid-context-card__readonly-value,
	.counter-grid-context-card__control :deep(.v-field__input),
	.counter-grid-date-picker :deep(.dp__input) {
		font-size: 0.86rem;
	}

	.counter-grid-total-hero__copy strong {
		font-size: 2.7rem;
	}

	.counter-grid-total-hero__watermark {
		display: none;
	}
}
</style>
