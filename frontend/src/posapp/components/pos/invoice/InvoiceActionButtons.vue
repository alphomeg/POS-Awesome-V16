<template>
	<div
		v-if="isCounterGrid"
		class="counter-grid-actions"
		:class="{
			'counter-grid-actions--with-return': pos_profile.posa_allow_return == 1,
			'counter-grid-actions--without-return': pos_profile.posa_allow_return != 1,
		}"
		data-testid="counter-grid-actions"
	>
		<v-btn
			variant="tonal"
			prepend-icon="mdi-content-save-outline"
			class="counter-grid-action counter-grid-action--save"
			data-pos-keyboard-target="invoice-action"
			data-testid="invoice-action-save-clear"
			:loading="saveLoading"
			@click="$emit('save-and-clear')"
		>
			{{ __("Save & Clear") }}
		</v-btn>
		<v-btn
			variant="tonal"
			prepend-icon="mdi-tray-full"
			class="counter-grid-action counter-grid-action--drafts"
			data-pos-keyboard-target="invoice-action"
			data-testid="invoice-action-drafts"
			:loading="loadDraftsLoading"
			@click="$emit('load-drafts')"
		>
			{{ __("Drafts") }}
		</v-btn>
		<v-btn
			variant="tonal"
			prepend-icon="mdi-folder-search-outline"
			class="counter-grid-action counter-grid-action--invoices"
			data-pos-keyboard-target="invoice-action"
			data-testid="invoice-action-management"
			:loading="invoiceManagementLoading"
			@click="$emit('open-invoice-management')"
		>
			{{ __("Invoices") }}
		</v-btn>
		<v-btn
			v-if="pos_profile.posa_allow_return == 1"
			variant="tonal"
			prepend-icon="mdi-backup-restore"
			class="counter-grid-action counter-grid-action--return"
			data-pos-keyboard-target="invoice-action"
			data-testid="invoice-action-returns"
			:loading="returnsLoading"
			@click="$emit('open-returns')"
		>
			{{ __("Return") }}
		</v-btn>
		<v-menu v-if="showMoreActions" location="top end">
			<template #activator="{ props: menuProps }">
				<v-btn
					v-bind="menuProps"
					variant="tonal"
					prepend-icon="mdi-dots-horizontal"
					class="counter-grid-action counter-grid-action--more"
					data-pos-keyboard-target="invoice-action"
					data-testid="invoice-action-more"
				>
					{{ __("More") }}
				</v-btn>
			</template>
			<v-list density="compact" min-width="220">
				<v-list-item
					prepend-icon="mdi-tag-outline"
					data-pos-keyboard-target="invoice-action"
					data-testid="invoice-action-offers"
					@click="$emit('open-offers')"
				>
					<v-list-item-title>{{ __("Offers") }}</v-list-item-title>
				</v-list-item>
				<v-list-item
					prepend-icon="mdi-ticket-percent-outline"
					data-pos-keyboard-target="invoice-action"
					data-testid="invoice-action-coupons"
					@click="$emit('open-coupons')"
				>
					<v-list-item-title>{{ __("Coupons") }}</v-list-item-title>
				</v-list-item>
				<v-list-item
					v-if="pos_profile.custom_allow_select_sales_order == 1"
					prepend-icon="mdi-book-search"
					data-testid="invoice-action-select-order"
					:disabled="selectOrderLoading"
					@click="$emit('select-order')"
				>
					<v-list-item-title>{{ __("Select Sales Order") }}</v-list-item-title>
				</v-list-item>
				<v-list-item
					v-if="pos_profile.posa_allow_print_draft_invoices"
					prepend-icon="mdi-printer"
					data-testid="invoice-action-print-draft"
					:disabled="printLoading"
					@click="$emit('print-draft')"
				>
					<v-list-item-title>{{ __("Print Draft") }}</v-list-item-title>
				</v-list-item>
				<v-list-item
					v-if="showCustomerDisplayButton"
					prepend-icon="mdi-monitor"
					data-testid="invoice-action-customer-display"
					:disabled="customerDisplayLoading"
					@click="$emit('open-customer-display')"
				>
					<v-list-item-title>{{ __("Customer Screen") }}</v-list-item-title>
				</v-list-item>
			</v-list>
		</v-menu>
		<v-btn
			color="error"
			variant="tonal"
			prepend-icon="mdi-close-circle-outline"
			class="counter-grid-action counter-grid-action--cancel"
			data-pos-keyboard-target="invoice-action"
			data-testid="invoice-action-cancel-sale"
			:loading="cancelLoading"
			@click="$emit('cancel-sale')"
		>
			{{ __("Cancel") }}
		</v-btn>
		<v-btn
			color="success"
			variant="flat"
			prepend-icon="mdi-credit-card-check-outline"
			class="counter-grid-action counter-grid-action--pay"
			data-pos-keyboard-target="pay"
			data-testid="invoice-action-pay"
			:loading="paymentLoading"
			@click="$emit('show-payment')"
		>
			{{ __("Pay") }}
		</v-btn>
	</div>

	<v-row v-else dense>
		<v-col cols="12" sm="6">
			<v-btn
				block
				color="accent"
				theme="dark"
				prepend-icon="mdi-content-save"
				@click="$emit('save-and-clear')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-save-clear"
				:loading="saveLoading"
			>
				{{ __("Save & Clear") }}
			</v-btn>
		</v-col>
		<v-col cols="12" sm="6">
			<v-btn
				block
				color="warning"
				theme="dark"
				prepend-icon="mdi-tray-full"
				@click="$emit('load-drafts')"
				class="white-text-btn summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-drafts"
				:loading="loadDraftsLoading"
			>
				{{ __("Drafts") }}
			</v-btn>
		</v-col>
		<v-col cols="12" sm="6" v-if="pos_profile.custom_allow_select_sales_order == 1">
			<v-btn
				block
				color="info"
				theme="dark"
				prepend-icon="mdi-book-search"
				@click="$emit('select-order')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-select-order"
				:loading="selectOrderLoading"
			>
				{{ __("Select S.O") }}
			</v-btn>
		</v-col>
		<v-col cols="12" sm="6">
			<v-btn
				block
				color="deep-purple"
				theme="dark"
				prepend-icon="mdi-folder-search-outline"
				@click="$emit('open-invoice-management')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-management"
				:loading="invoiceManagementLoading"
			>
				{{ __("Invoice Mgmt") }}
			</v-btn>
		</v-col>
		<v-col cols="12" sm="6">
			<v-btn
				block
				color="error"
				theme="dark"
				prepend-icon="mdi-close-circle"
				@click="$emit('cancel-sale')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-cancel-sale"
				:loading="cancelLoading"
			>
				{{ __("Cancel Sale") }}
			</v-btn>
		</v-col>

		<v-col cols="12" sm="6" v-if="pos_profile.posa_allow_return == 1">
			<v-btn
				block
				color="secondary"
				theme="dark"
				prepend-icon="mdi-backup-restore"
				@click="$emit('open-returns')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-returns"
				:loading="returnsLoading"
			>
				{{ __("Sales Return") }}
			</v-btn>
		</v-col>
		<v-col cols="12" sm="6" v-if="pos_profile.posa_allow_print_draft_invoices">
			<v-btn
				block
				color="primary"
				theme="dark"
				prepend-icon="mdi-printer"
				@click="$emit('print-draft')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-print-draft"
				:loading="printLoading"
			>
				{{ __("Print Draft") }}
			</v-btn>
		</v-col>
		<v-col cols="12" sm="6" v-if="showCustomerDisplayButton">
			<v-btn
				block
				color="indigo"
				theme="dark"
				prepend-icon="mdi-monitor"
				@click="$emit('open-customer-display')"
				class="summary-btn"
				data-pos-keyboard-target="invoice-action"
				data-testid="invoice-action-customer-display"
				:loading="customerDisplayLoading"
			>
				{{ __("Customer Screen") }}
			</v-btn>
		</v-col>
		<v-col cols="12">
			<v-btn
				block
				color="success"
				theme="dark"
				size="large"
				prepend-icon="mdi-credit-card"
				@click="$emit('show-payment')"
				class="summary-btn pay-btn"
				data-pos-keyboard-target="pay"
				data-testid="invoice-action-pay"
				:loading="paymentLoading"
			>
				{{ __("PAY") }}
			</v-btn>
		</v-col>
	</v-row>
</template>

<script setup>
import { computed } from "vue";
import { parseBooleanSetting } from "../../../utils/stock";

const props = defineProps({
	presentation: {
		type: String,
		default: "classic",
	},
	pos_profile: {
		type: Object,
		required: true,
		default: () => ({}),
	},
	saveLoading: Boolean,
	loadDraftsLoading: Boolean,
	selectOrderLoading: Boolean,
	cancelLoading: Boolean,
	invoiceManagementLoading: Boolean,
	returnsLoading: Boolean,
	printLoading: Boolean,
	paymentLoading: Boolean,
	customerDisplayLoading: Boolean,
});

defineEmits([
	"save-and-clear",
	"load-drafts",
	"select-order",
	"cancel-sale",
	"open-invoice-management",
	"open-returns",
	"print-draft",
	"show-payment",
	"open-customer-display",
	"open-offers",
	"open-coupons",
]);

const __ = window.__;
const isCounterGrid = computed(() => props.presentation === "counter-grid");
const showCustomerDisplayButton = computed(() =>
	parseBooleanSetting(props.pos_profile?.posa_enable_customer_display),
);
const showMoreActions = computed(
	() =>
		isCounterGrid.value ||
		props.pos_profile?.custom_allow_select_sales_order == 1 ||
		Boolean(props.pos_profile?.posa_allow_print_draft_invoices) ||
		showCustomerDisplayButton.value,
);
</script>

<style scoped>
.counter-grid-actions {
	display: grid;
	gap: 9px;
	min-width: 0;
	padding-inline: 1px 15px;
}

.counter-grid-actions--with-return {
	grid-template-columns: repeat(5, minmax(0, 1fr)) minmax(0, 0.94fr) minmax(0, 1.755fr);
}

.counter-grid-actions--without-return {
	grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 0.94fr) minmax(0, 1.755fr);
}

.counter-grid-action {
	height: 54px !important;
	min-width: 0 !important;
	padding-inline: 12px !important;
	border: 1px solid var(--rm-cg-line) !important;
	border-radius: 5px !important;
	background: var(--rm-cg-action-more-bg) !important;
	color: var(--rm-cg-action-more-text) !important;
	font-size: 0.88rem !important;
	font-weight: 700 !important;
	letter-spacing: 0 !important;
	text-transform: none !important;
}

.counter-grid-action:hover {
	border-color: currentColor !important;
	background: var(--rm-cg-action-more-hover) !important;
}

.counter-grid-action--save {
	border-color: var(--rm-cg-action-save-text) !important;
	background: var(--rm-cg-action-save-bg) !important;
	box-shadow: none !important;
	color: var(--rm-cg-action-save-text) !important;
}

.counter-grid-action--save:hover {
	background: var(--rm-cg-action-save-hover) !important;
}

.counter-grid-action--drafts {
	border-color: var(--rm-cg-action-drafts-text) !important;
	background: var(--rm-cg-action-drafts-bg) !important;
	color: var(--rm-cg-action-drafts-text) !important;
}

.counter-grid-action--drafts:hover {
	background: var(--rm-cg-action-drafts-hover) !important;
}

.counter-grid-action--invoices {
	border-color: var(--rm-cg-action-invoices-text) !important;
	background: var(--rm-cg-action-invoices-bg) !important;
	color: var(--rm-cg-action-invoices-text) !important;
}

.counter-grid-action--invoices:hover {
	background: var(--rm-cg-action-invoices-hover) !important;
}

.counter-grid-action--return {
	border-color: var(--rm-cg-action-return-text) !important;
	background: var(--rm-cg-action-return-bg) !important;
	color: var(--rm-cg-action-return-text) !important;
}

.counter-grid-action--return:hover {
	background: var(--rm-cg-action-return-hover) !important;
}

.counter-grid-action--more {
	border-color: var(--rm-cg-action-more-text) !important;
	background: var(--rm-cg-action-more-bg) !important;
	color: var(--rm-cg-action-more-text) !important;
}

.counter-grid-action.text-error,
.counter-grid-action--cancel {
	border-color: #b7202a !important;
	background: var(--rm-cg-shell-cancel) !important;
	color: #ffffff !important;
}

.counter-grid-action :deep(.v-btn__content) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.counter-grid-action--pay {
	border-color: #066b3b !important;
	background: var(--rm-cg-shell-pay) !important;
	color: #ffffff !important;
	font-size: 0.96rem !important;
}

.counter-grid-action--pay:hover {
	background: #066b3b !important;
}

@media (max-width: 1199px) {
	.counter-grid-action {
		padding-inline: 6px !important;
		font-size: 0.74rem !important;
	}

	.counter-grid-action :deep(.v-icon) {
		font-size: 16px !important;
	}
}

@media (max-width: 1439px), (max-height: 819px) {
	.counter-grid-actions {
		gap: 6px;
		padding-inline: 0;
	}

	.counter-grid-action {
		height: 48px !important;
		font-size: 0.8rem !important;
	}
}

.white-text-btn {
	color: var(--pos-text-primary) !important;
}

.white-text-btn :deep(.v-btn__content) {
	color: var(--pos-text-primary) !important;
}

/* Enhanced button styling with better performance */
.summary-btn {
	transition: all 0.2s ease !important;
	position: relative;
	overflow: hidden;
	min-height: 46px !important;
	text-transform: none !important;
}

.summary-btn :deep(.v-btn__content) {
	white-space: normal !important;
	transition: all 0.2s ease;
}

.summary-btn:hover {
	transform: translateY(-1px);
	box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15) !important;
}

.summary-btn:active {
	transform: translateY(0);
}

/* Special styling for the PAY button */
.pay-btn {
	font-weight: 600 !important;
	font-size: 1.1rem !important;
	background: linear-gradient(135deg, #4caf50, #45a049) !important;
	box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3) !important;
}

.pay-btn:hover {
	background: linear-gradient(135deg, #45a049, #3d8b40) !important;
	box-shadow: 0 6px 16px rgba(76, 175, 80, 0.4) !important;
	transform: translateY(-2px);
}

/* Responsive optimizations */
@media (max-width: 768px) {
	.summary-btn {
		font-size: 0.8rem !important;
		padding: 4px 8px !important;
		min-height: 42px !important;
	}

	.pay-btn {
		font-size: 0.95rem !important;
		min-height: 48px !important;
	}
}

@media (max-width: 480px) {
	.summary-btn {
		font-size: 0.74rem !important;
		padding: 3px 6px !important;
		min-height: 34px !important;
	}

	.pay-btn {
		font-size: 0.85rem !important;
		min-height: 40px !important;
	}
}

/* Loading state animations */
.summary-btn:deep(.v-btn__loader) {
	opacity: 0.8;
}

/* Dark theme enhancements */
:deep([data-theme="dark"]) .summary-btn,
:deep(.v-theme--dark) .summary-btn {
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
}

:deep([data-theme="dark"]) .summary-btn:hover,
:deep(.v-theme--dark) .summary-btn:hover {
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4) !important;
}
</style>
