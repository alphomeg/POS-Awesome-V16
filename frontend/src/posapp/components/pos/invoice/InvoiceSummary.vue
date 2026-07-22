<template>
	<v-card
		class="cards sticky-summary-card mb-0 py-2 px-3 rounded-lg pos-themed-card"
		:class="{
			'sticky-summary-card--dock-safe': useCompactSaleDock && !isCounterGrid,
			'counter-grid-summary-card': isCounterGrid,
		}"
	>
		<div v-if="isCounterGrid" class="counter-grid-summary" data-testid="counter-grid-summary">
			<div class="counter-grid-summary__metrics">
				<div class="counter-grid-summary__metric">
					<v-icon icon="mdi-receipt-text-outline" size="28" />
					<div class="counter-grid-summary__copy">
						<span>{{ __("Gross") }}</span>
						<strong>{{ currencySymbol(displayCurrency) }}{{ formatCurrency(grossTotal) }}</strong>
					</div>
				</div>
				<div class="counter-grid-summary__metric">
					<v-icon icon="mdi-tag-outline" size="28" />
					<div class="counter-grid-summary__copy">
						<span>{{ __("Item Discount") }}</span>
						<strong
							>{{ currencySymbol(displayCurrency)
							}}{{ formatCurrency(total_items_discount_amount) }}</strong
						>
					</div>
				</div>
				<div class="counter-grid-summary__metric counter-grid-summary__metric--qty">
					<v-icon icon="mdi-cube-outline" size="28" />
					<div class="counter-grid-summary__copy">
						<span>{{ __("Quantity") }}</span>
						<strong>{{ formatFloat(total_qty, hide_qty_decimals ? 0 : undefined) }}</strong>
					</div>
				</div>
				<div class="counter-grid-summary__discount">
					<v-icon icon="mdi-sale-outline" size="28" />
					<v-text-field
						v-if="!pos_profile.posa_use_percentage_discount"
						ref="additionalDiscountField"
						v-model="additionalDiscountDisplay"
						@update:model-value="handleAdditionalDiscountUpdate"
						@focus="handleAdditionalDiscountFocus"
						@blur="handleAdditionalDiscountBlur"
						:label="frappe._('Additional Discount')"
						variant="outlined"
						density="compact"
						hide-details
						:prefix="currencySymbol(pos_profile.currency)"
						:disabled="
							!pos_profile.posa_allow_user_to_edit_additional_discount ||
							!!discount_percentage_offer_name
						"
					/>
					<v-text-field
						v-else
						ref="additionalDiscountField"
						v-model="additionalDiscountPercentageDisplay"
						@update:model-value="handleAdditionalDiscountPercentageUpdate"
						@change="$emit('update_discount_umount')"
						@focus="handleAdditionalDiscountPercentageFocus"
						@blur="handleAdditionalDiscountPercentageBlur"
						:rules="[isNumber]"
						:label="frappe._('Additional Discount')"
						suffix="%"
						variant="outlined"
						density="compact"
						hide-details
						:disabled="
							!pos_profile.posa_allow_user_to_edit_additional_discount ||
							!!discount_percentage_offer_name
						"
					/>
				</div>
			</div>

			<InvoiceActionButtons
				ref="counterGridActionButtons"
				presentation="counter-grid"
				:pos_profile="pos_profile"
				:saveLoading="saveLoading"
				:loadDraftsLoading="loadDraftsLoading"
				:selectOrderLoading="selectOrderLoading"
				:cancelLoading="cancelLoading"
				:invoiceManagementLoading="invoiceManagementLoading"
				:returnsLoading="returnsLoading"
				:printLoading="printLoading"
				:paymentLoading="paymentLoading"
				:customerDisplayLoading="customerDisplayLoading"
				@save-and-clear="handleSaveAndClear"
				@load-drafts="handleLoadDrafts"
				@select-order="handleSelectOrder"
				@cancel-sale="handleCancelSale"
				@open-invoice-management="handleOpenInvoiceManagement"
				@open-returns="handleOpenReturns"
				@print-draft="handlePrintDraft"
				@show-payment="handleShowPayment"
				@open-customer-display="handleOpenCustomerDisplay"
				@open-offers="$emit('open-offers')"
				@open-coupons="$emit('open-coupons')"
				@navigate-back="$emit('focus-counter-grid-entry')"
			/>
		</div>

		<v-row v-else dense class="summary-content">
			<v-col
				v-if="!useCompactSaleDock || showReturnDiscountAlert"
				cols="12"
				:md="useCompactSaleDock ? 12 : 7"
			>
				<v-alert
					v-if="showReturnDiscountAlert"
					density="compact"
					type="info"
					variant="tonal"
					class="summary-field summary-field--alert"
				>
					{{ __("Prorated return discount") }}: {{ formatRatio(return_discount_meta.ratio) }} -
					{{ __("Original") }}: {{ formatCurrency(return_discount_meta.original_discount) }},
					{{ __("Applied") }}:
					{{ formatCurrency(return_discount_meta.prorated_discount) }}
				</v-alert>

				<div v-if="!useCompactSaleDock" class="summary-hero">
					<div class="summary-hero__copy">
						<span class="summary-hero__eyebrow">{{ __("Active sale") }}</span>
						<strong class="summary-hero__amount">
							{{ currencySymbol(displayCurrency) }}{{ formatCurrency(subtotal) }}
						</strong>
						<div class="summary-hero__meta">
							<span
								>{{ formatFloat(total_qty, hide_qty_decimals ? 0 : undefined) }}
								{{ __("qty") }}</span
							>
							<span>
								{{ currencySymbol(displayCurrency)
								}}{{ formatCurrency(total_items_discount_amount) }}
								{{ __("discount") }}
							</span>
						</div>
					</div>

					<div class="summary-hero__field-wrap">
						<v-text-field
							v-if="!pos_profile.posa_use_percentage_discount"
							ref="additionalDiscountField"
							v-model="additionalDiscountDisplay"
							@update:model-value="handleAdditionalDiscountUpdate"
							@focus="handleAdditionalDiscountFocus"
							@blur="handleAdditionalDiscountBlur"
							:label="frappe._('Additional Discount')"
							prepend-inner-icon="mdi-cash-minus"
							variant="solo"
							density="compact"
							color="warning"
							:prefix="currencySymbol(pos_profile.currency)"
							:disabled="
								!pos_profile.posa_allow_user_to_edit_additional_discount ||
								!!discount_percentage_offer_name
							"
							class="summary-field summary-field--dock"
						/>

						<v-text-field
							v-else
							ref="additionalDiscountField"
							v-model="additionalDiscountPercentageDisplay"
							@update:model-value="handleAdditionalDiscountPercentageUpdate"
							@change="$emit('update_discount_umount')"
							@focus="handleAdditionalDiscountPercentageFocus"
							@blur="handleAdditionalDiscountPercentageBlur"
							:rules="[isNumber]"
							:label="frappe._('Additional Discount %')"
							suffix="%"
							prepend-inner-icon="mdi-percent"
							variant="solo"
							density="compact"
							color="warning"
							:disabled="
								!pos_profile.posa_allow_user_to_edit_additional_discount ||
								!!discount_percentage_offer_name
							"
							class="summary-field summary-field--dock"
						/>
					</div>
				</div>
			</v-col>

			<v-col cols="12" :md="useCompactSaleDock ? 12 : 5" class="invoice-summary-actions">
				<InvoiceActionButtons
					:pos_profile="pos_profile"
					:saveLoading="saveLoading"
					:loadDraftsLoading="loadDraftsLoading"
					:selectOrderLoading="selectOrderLoading"
					:cancelLoading="cancelLoading"
					:invoiceManagementLoading="invoiceManagementLoading"
					:returnsLoading="returnsLoading"
					:printLoading="printLoading"
					:paymentLoading="paymentLoading"
					:customerDisplayLoading="customerDisplayLoading"
					@save-and-clear="handleSaveAndClear"
					@load-drafts="handleLoadDrafts"
					@select-order="handleSelectOrder"
					@cancel-sale="handleCancelSale"
					@open-invoice-management="handleOpenInvoiceManagement"
					@open-returns="handleOpenReturns"
					@print-draft="handlePrintDraft"
					@show-payment="handleShowPayment"
					@open-customer-display="handleOpenCustomerDisplay"
				/>
			</v-col>
		</v-row>
	</v-card>

	<v-navigation-drawer
		v-if="showDesktopDrafts"
		v-model="desktopDraftsDrawer"
		location="right"
		temporary
		width="360"
		class="drafts-drawer"
	>
		<div class="drafts-drawer__body" data-drafts-focus-root>
			<DocumentSourceSelector
				v-if="showDraftSourceSelector"
				v-model="currentDraftSource"
				:options="availableDraftSources"
				compact
				:aria-label="__('Draft source')"
				class="drafts-drawer__sources"
			/>
			<ParkedOrdersList
				ref="desktopDraftsList"
				:parked-orders="allDrafts"
				:format-currency="formatCurrency"
				:currency-symbol="currencySymbol"
				:show-manage-all="true"
				:loading="loadDraftsLoading"
				:loading-title="__(currentDraftSourceOption.loadingLabel)"
				:title="currentDraftSourceOption.panelTitle"
				:eyebrow="currentDraftSourceOption.panelEyebrow"
				:subtitle="currentDraftSourceOption.panelSubtitle"
				:empty-title="__(currentDraftSourceOption.emptyTitle)"
				:empty-subtitle="__(currentDraftSourceOption.emptySubtitle)"
				@resume="handleResumeDraft"
				@manage-all="handleManageAllDrafts"
				@close="closeDraftsSurface"
			/>
		</div>
	</v-navigation-drawer>

	<v-dialog v-else v-model="mobileDraftsDialog" max-width="680" scrollable data-test="mobile-drafts-dialog">
		<v-card class="pos-themed-card">
			<v-card-title class="d-flex align-center justify-space-between">
				<span>{{ __(currentDraftSourceOption.panelTitle) }}</span>
				<v-btn variant="text" size="small" @click="closeDraftsSurface">
					{{ __("Close") }}
				</v-btn>
			</v-card-title>
			<v-card-text class="pt-0" data-drafts-focus-root>
				<DocumentSourceSelector
					v-if="showDraftSourceSelector"
					v-model="currentDraftSource"
					:options="availableDraftSources"
					compact
					:aria-label="__('Draft source')"
					class="drafts-drawer__sources"
				/>
				<ParkedOrdersList
					ref="mobileDraftsList"
					:parked-orders="allDrafts"
					:format-currency="formatCurrency"
					:currency-symbol="currencySymbol"
					:show-manage-all="true"
					:loading="loadDraftsLoading"
					:loading-title="__(currentDraftSourceOption.loadingLabel)"
					:title="currentDraftSourceOption.panelTitle"
					:eyebrow="currentDraftSourceOption.panelEyebrow"
					:subtitle="currentDraftSourceOption.panelSubtitle"
					:empty-title="__(currentDraftSourceOption.emptyTitle)"
					:empty-subtitle="__(currentDraftSourceOption.emptySubtitle)"
					@resume="handleResumeDraft"
					@manage-all="handleManageAllDrafts"
					@close="closeDraftsSurface"
				/>
			</v-card-text>
		</v-card>
	</v-dialog>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { loadItemSelectorSettings } from "../../../utils/itemSelectorSettings";
import { useResponsive } from "../../../composables/core/useResponsive";
import { useUIStore } from "../../../stores/uiStore";
import {
	getAvailableDocumentSources,
	getDefaultDocumentSource,
	getDocumentSourceOption,
	shouldShowDocumentSourceSelector,
} from "../../../utils/documentSources";
import InvoiceActionButtons from "./InvoiceActionButtons.vue";
import ParkedOrdersList from "./ParkedOrdersList.vue";
import DocumentSourceSelector from "../shared/DocumentSourceSelector.vue";

defineOptions({
	name: "InvoiceSummary",
});

const props = defineProps({
	presentation: {
		type: String,
		default: "classic",
	},
	pos_profile: Object,
	total_qty: [Number, String],
	additional_discount: Number,
	additional_discount_percentage: Number,
	total_items_discount_amount: Number,
	grossTotal: Number,
	subtotal: Number,
	displayCurrency: String,
	formatFloat: Function,
	formatCurrency: Function,
	currencySymbol: Function,
	discount_percentage_offer_name: [String, Number],
	isNumber: Function,
	return_discount_meta: Object,
});

const emit = defineEmits([
	"update:additional_discount",
	"update:additional_discount_percentage",
	"update_discount_umount",
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
	"focus-counter-grid-entry",
	"focus-item-search",
	"resume-parked-order",
]);

const saveLoading = ref(false);
const loadDraftsLoading = ref(false);
const selectOrderLoading = ref(false);
const cancelLoading = ref(false);
const invoiceManagementLoading = ref(false);
const returnsLoading = ref(false);
const printLoading = ref(false);
const paymentLoading = ref(false);
const customerDisplayLoading = ref(false);
const isEditingAdditionalDiscount = ref(false);
const isEditingAdditionalDiscountPercentage = ref(false);
const additionalDiscountField = ref(null);
const counterGridActionButtons = ref(null);
const desktopDraftsDrawer = ref(false);
const mobileDraftsDialog = ref(false);
const desktopDraftsList = ref(null);
const mobileDraftsList = ref(null);
const responsive = useResponsive();
const uiStore = useUIStore();
const { parkedOrders, draftSource } = storeToRefs(uiStore);

const additionalDiscountDisplay = ref(normalizeAdditionalDiscountDisplay(props.additional_discount));
const additionalDiscountPercentageDisplay = ref(
	normalizeDiscountDisplay(props.additional_discount_percentage),
);
const isCounterGrid = computed(() => props.presentation === "counter-grid");
const useCompactSaleDock = computed(() => responsive.windowWidth.value < 1100);
const showDesktopDrafts = computed(() => Boolean(responsive.isDesktop.value));
const showReturnDiscountAlert = computed(
	() =>
		!!props.return_discount_meta &&
		!props.pos_profile?.posa_use_percentage_discount &&
		!isFullReturnDiscount(props.return_discount_meta?.ratio),
);
const allDrafts = computed(() => (Array.isArray(parkedOrders.value) ? parkedOrders.value : []));
const availableDraftSources = computed(() => getAvailableDocumentSources(props.pos_profile));
const showDraftSourceSelector = computed(() => shouldShowDocumentSourceSelector(availableDraftSources.value));
const currentDraftSource = computed({
	get() {
		return getDefaultDocumentSource(props.pos_profile, draftSource.value);
	},
	async set(value) {
		const nextSource = getDefaultDocumentSource(props.pos_profile, value);
		if (draftSource.value === nextSource) {
			return;
		}
		uiStore.setDraftSource(nextSource);
		uiStore.setParkedOrders([]);
		await emit("load-drafts", nextSource);
	},
});
const currentDraftSourceOption = computed(() => getDocumentSourceOption(currentDraftSource.value));

const hide_qty_decimals = computed(() => {
	const opts = loadItemSelectorSettings();
	return !!opts?.hide_qty_decimals;
});

watch(
	() => props.pos_profile,
	() => {
		const nextSource = getDefaultDocumentSource(props.pos_profile, draftSource.value);
		if (draftSource.value !== nextSource) {
			uiStore.setDraftSource(nextSource);
		}
	},
	{ deep: true, immediate: true },
);

watch(
	() => [
		props.additional_discount,
		props.return_discount_meta?.prorated_discount,
		props.pos_profile?.posa_use_percentage_discount,
	],
	([value]) => {
		if (!isEditingAdditionalDiscount.value) {
			additionalDiscountDisplay.value = normalizeAdditionalDiscountDisplay(value);
		}
	},
);

watch(
	() => props.additional_discount_percentage,
	(value) => {
		if (!isEditingAdditionalDiscountPercentage.value) {
			additionalDiscountPercentageDisplay.value = normalizeDiscountDisplay(value);
		}
	},
);

function normalizeDiscountDisplay(value) {
	if (value === 0 || value === "0") {
		return "";
	}
	return value;
}

function normalizeAdditionalDiscountDisplay(value) {
	if (value === 0 || value === "0") {
		return "";
	}
	if (props.return_discount_meta && !props.pos_profile?.posa_use_percentage_discount) {
		const proratedValue = Number(props.return_discount_meta.prorated_discount);
		if (Number.isFinite(proratedValue)) {
			return Math.abs(proratedValue);
		}
		const numericValue = Number(value);
		if (Number.isFinite(numericValue)) {
			return Math.abs(numericValue);
		}
	}
	return value;
}

function normalizeAdditionalDiscountInput(value) {
	if (props.return_discount_meta && !props.pos_profile?.posa_use_percentage_discount) {
		const numericValue = Number(value);
		if (Number.isFinite(numericValue)) {
			const originalStoredValue = Number(props.additional_discount);
			const sign = Math.sign(
				Number.isFinite(originalStoredValue) && originalStoredValue !== 0 ? originalStoredValue : -1,
			);
			return sign * Math.abs(numericValue);
		}
	}
	return value;
}

function handleAdditionalDiscountUpdate(value) {
	emit("update:additional_discount", normalizeAdditionalDiscountInput(value));
}

function handleAdditionalDiscountFocus() {
	isEditingAdditionalDiscount.value = true;
}

function handleAdditionalDiscountBlur() {
	isEditingAdditionalDiscount.value = false;
}

function handleAdditionalDiscountPercentageUpdate(value) {
	emit("update:additional_discount_percentage", value);
}

function handleAdditionalDiscountPercentageFocus() {
	isEditingAdditionalDiscountPercentage.value = true;
}

function handleAdditionalDiscountPercentageBlur() {
	isEditingAdditionalDiscountPercentage.value = false;
}

function focusAdditionalDiscountField() {
	const field = additionalDiscountField.value;
	field?.focus?.();
	field?.$el?.querySelector?.("input")?.focus?.();
}

function focusCounterGridActions() {
	return counterGridActionButtons.value?.focusFirstAction?.() || false;
}

function focusCounterGridPay() {
	return counterGridActionButtons.value?.focusPayAction?.() || false;
}

function formatRatio(value) {
	const ratio = Number.isFinite(Number(value)) ? Number(value) : 0;
	const percent = Math.round(ratio * 10000) / 100;
	return `${percent}%`;
}

function isFullReturnDiscount(value) {
	const ratio = Number.isFinite(Number(value)) ? Number(value) : 0;
	return Math.abs(ratio - 1) < 0.0001;
}

async function handleSaveAndClear() {
	saveLoading.value = true;
	try {
		await emit("save-and-clear");
	} finally {
		saveLoading.value = false;
	}
}

function handleLoadDrafts() {
	const nextSource = getDefaultDocumentSource(props.pos_profile, "invoice");
	uiStore.setDraftSource(nextSource);
	uiStore.setParkedOrders([]);
	openDraftsSurface();
	emit("load-drafts", nextSource);
}

function openDraftsSurface(options = {}) {
	if (showDesktopDrafts.value) {
		desktopDraftsDrawer.value = true;
		if (options.focus !== false) {
			void focusDraftsSurface();
		}
		return;
	}

	mobileDraftsDialog.value = true;
	if (options.focus !== false) {
		void focusDraftsSurface();
	}
}

function restoreDraftsReturnFocus() {
	emit("focus-item-search");
}

function closeDraftsSurface(options = {}) {
	desktopDraftsDrawer.value = false;
	mobileDraftsDialog.value = false;
	if (options.restoreFocus !== false) {
		void restoreDraftsReturnFocus();
	}
}

function handleGlobalDraftsKeydown(event) {
	const isDraftsOpen = desktopDraftsDrawer.value || mobileDraftsDialog.value;
	if (!isDraftsOpen || (event.key !== "Escape" && event.key !== "ArrowLeft")) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation?.();
	closeDraftsSurface();
}

async function focusDraftsSurface() {
	await nextTick();
	await new Promise((resolve) => {
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(resolve);
			return;
		}
		setTimeout(resolve, 0);
	});
	const list = showDesktopDrafts.value ? desktopDraftsList.value : mobileDraftsList.value;
	await list?.focusFirstDraft?.();
}

async function handleSelectOrder() {
	selectOrderLoading.value = true;
	try {
		await emit("select-order");
	} finally {
		selectOrderLoading.value = false;
	}
}

async function handleCancelSale() {
	cancelLoading.value = true;
	try {
		await emit("cancel-sale");
	} finally {
		cancelLoading.value = false;
	}
}

async function handleOpenInvoiceManagement() {
	invoiceManagementLoading.value = true;
	try {
		await emit("open-invoice-management");
	} finally {
		invoiceManagementLoading.value = false;
	}
}

function handleManageAllDrafts() {
	closeDraftsSurface({ restoreFocus: false });
	uiStore.setInvoiceManagementDraftSource(currentDraftSource.value);
	emit("open-invoice-management", "drafts", currentDraftSource.value);
}

async function handleOpenReturns() {
	returnsLoading.value = true;
	try {
		await emit("open-returns");
	} finally {
		returnsLoading.value = false;
	}
}

async function handlePrintDraft() {
	printLoading.value = true;
	try {
		await emit("print-draft");
	} finally {
		printLoading.value = false;
	}
}

async function handleShowPayment() {
	paymentLoading.value = true;
	try {
		await emit("show-payment");
	} finally {
		paymentLoading.value = false;
	}
}

async function handleOpenCustomerDisplay() {
	customerDisplayLoading.value = true;
	try {
		await emit("open-customer-display");
	} finally {
		customerDisplayLoading.value = false;
	}
}

function handleResumeDraft(draft) {
	closeDraftsSurface();
	emit("resume-parked-order", draft);
}

onMounted(() => {
	window.addEventListener("keydown", handleGlobalDraftsKeydown, true);
});

onBeforeUnmount(() => {
	window.removeEventListener("keydown", handleGlobalDraftsKeydown, true);
});

defineExpose({
	focusAdditionalDiscountField,
	focusCounterGridActions,
	focusCounterGridPay,
	focusDraftsSurface,
	handleManageAllDrafts,
	openDraftsSurface,
	closeDraftsSurface,
	setDraftsLoading(value) {
		loadDraftsLoading.value = Boolean(value);
	},
});
</script>

<style scoped>
.drafts-drawer :deep(.v-navigation-drawer__content) {
	padding: 12px;
	background: var(--pos-surface-muted);
}

.drafts-drawer__body {
	padding: 4px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.drafts-drawer__sources {
	position: sticky;
	top: 0;
	z-index: 1;
	padding: 4px;
	background: var(--pos-surface-muted);
	border-radius: 16px;
}

.cards {
	background-color: var(--pos-card-bg) !important;
	transition: all 0.3s ease;
}

.counter-grid-summary-card {
	position: static;
	padding: 0 !important;
	margin-bottom: 17px !important;
	border: 0;
	border-radius: 0 !important;
	box-shadow: none;
	background: transparent !important;
}

.counter-grid-summary {
	display: grid;
	gap: 12px;
}

.counter-grid-summary__metrics {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 2fr);
	min-height: 80px;
	border: 1px solid var(--rm-cg-shell-card-line);
	border-radius: 7px;
	background: var(--rm-cg-surface);
	box-shadow: var(--rm-cg-shell-card-shadow);
	overflow: hidden;
	min-width: 0;
}

.counter-grid-summary__metric {
	display: flex;
	align-items: center;
	gap: 16px;
	min-width: 0;
	height: 80px;
	padding: 10px 28px;
	border-inline-end: 1px solid var(--rm-cg-line-soft);
	background: var(--rm-cg-surface);
}

.counter-grid-summary__metric > .v-icon,
.counter-grid-summary__discount > .v-icon {
	flex: 0 0 auto;
	color: var(--rm-cg-shell-icon);
}

.counter-grid-summary__copy {
	display: flex;
	min-width: 0;
	flex-direction: column;
	justify-content: center;
}

.counter-grid-summary__copy span {
	font-size: 0.78rem;
	font-weight: 500;
	color: var(--rm-cg-text-muted);
}

.counter-grid-summary__copy strong {
	overflow: hidden;
	font-size: 1rem;
	font-variant-numeric: tabular-nums;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--rm-cg-text);
}

.counter-grid-summary__discount {
	display: flex;
	align-items: center;
	gap: 16px;
	min-width: 0;
	height: 80px;
	padding: 8px 28px;
	background: var(--rm-cg-surface);
}

.counter-grid-summary__discount :deep(.v-field) {
	height: 62px;
	border-radius: 4px;
	background: transparent;
}

.counter-grid-summary__discount :deep(.v-field__input) {
	min-height: 62px;
	padding-top: 20px;
	font-size: 1rem;
	font-weight: 650;
	font-variant-numeric: tabular-nums;
}

.counter-grid-summary__discount :deep(.v-field__outline) {
	display: none;
}

.counter-grid-summary__discount :deep(.v-label) {
	font-size: 0.78rem;
	font-weight: 500;
	color: var(--rm-cg-text-muted) !important;
}

.counter-grid-summary__discount:focus-within {
	border-radius: 4px;
	box-shadow: inset 0 0 0 3px var(--rm-cg-focus);
}

@media (max-width: 1439px), (max-height: 819px) {
	.counter-grid-summary-card {
		margin-bottom: 0 !important;
	}

	.counter-grid-summary {
		gap: 8px;
	}

	.counter-grid-summary__metrics {
		min-height: 60px;
	}

	.counter-grid-summary__metric,
	.counter-grid-summary__discount {
		height: 60px;
		gap: 9px;
		padding: 5px 12px;
	}

	.counter-grid-summary__metric > .v-icon,
	.counter-grid-summary__discount > .v-icon {
		font-size: 22px !important;
	}

	.counter-grid-summary__discount :deep(.v-field),
	.counter-grid-summary__discount :deep(.v-field__input) {
		height: 50px;
		min-height: 50px;
	}
}

.sticky-summary-card {
	position: sticky;
	bottom: 0;
	z-index: 9;
	box-shadow: 0 -8px 24px rgba(15, 23, 42, 0.08);
}

.sticky-summary-card--dock-safe {
	margin-bottom: calc(var(--bottom-safe-space) + 8px);
}

.summary-content {
	row-gap: 6px;
}

.summary-hero {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14px;
	padding: 14px 16px;
	border-radius: 20px;
	background:
		linear-gradient(135deg, rgba(var(--v-theme-primary), 0.12), rgba(var(--v-theme-success), 0.08)),
		var(--pos-surface-muted);
	border: 1px solid rgba(var(--v-theme-primary), 0.12);
}

.summary-hero__copy {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.summary-hero__eyebrow {
	font-size: 0.72rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0;
	color: var(--pos-text-secondary);
}

.summary-hero__amount {
	font-size: clamp(1.2rem, 2vw, 1.8rem);
	line-height: 1.1;
	color: var(--pos-text-primary);
}

.summary-hero__meta {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 14px;
	font-size: 0.84rem;
	color: var(--pos-text-secondary);
}

.summary-hero__field-wrap {
	width: min(260px, 100%);
}

.invoice-summary-actions {
	position: sticky;
	bottom: 0;
}

.summary-field {
	transition: all 0.2s ease;
}

.summary-field:hover {
	transform: translateY(-1px);
	box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.summary-field--alert {
	margin-bottom: 10px;
}

.summary-field--dock :deep(.v-field) {
	background: rgba(var(--v-theme-surface), 0.92);
}

@media (max-width: 1279px) {
	.sticky-summary-card {
		position: static;
		bottom: auto;
		box-shadow: none;
	}

	.invoice-summary-actions {
		position: static;
	}
}

@media (max-width: 1099px) {
	.sticky-summary-card--dock-safe {
		margin-bottom: calc(var(--bottom-safe-space) + 12px);
	}
}

@media (max-width: 768px) {
	.sticky-summary-card {
		position: static;
		bottom: auto;
		box-shadow: none;
	}

	.summary-hero {
		flex-direction: column;
		align-items: stretch;
		padding: 12px;
	}

	.summary-hero__field-wrap {
		width: 100%;
	}

	.invoice-summary-actions {
		position: static;
	}

	.cards {
		padding: 10px 12px !important;
	}

	.summary-field {
		font-size: 0.875rem;
	}

	.sticky-summary-card--dock-safe {
		margin-bottom: calc(var(--bottom-safe-space) + 8px);
	}
}
</style>
