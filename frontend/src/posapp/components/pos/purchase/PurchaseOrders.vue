<template>
	<div
		ref="workspaceRoot"
		class="purchase-workspace pa-0 h-100"
		data-pos-keyboard-root
		@keydown.capture="handleWorkspaceKeydown"
	>
		<v-alert
			v-if="entitlementStatus.read_only"
			type="warning"
			density="compact"
			variant="tonal"
			class="ma-2 mb-0"
			role="status"
		>
			<strong>{{ __("Purchasing is read-only") }}.</strong>
			{{ entitlementStatus.reason || __("Purchasing access is unavailable on this terminal.") }}
			{{ __("Past purchase orders remain available below.") }}
		</v-alert>
		<v-row class="purchase-workspace__body ma-0">
			<!-- Left Column: Item Selector -->
			<v-col
				cols="12"
				md="3"
				class="h-100 pa-0 border-e purchase-selector-column"
				:class="{ 'purchase-write-locked': entitlementStatus.read_only }"
			>
				<ItemsSelector
					context="purchase"
					:price-list-override="supplierPriceList || defaultBuyingPriceList"
					@add-item="onAddItem"
				/>
			</v-col>

			<!-- Right Column: Purchase Order Form (Cart) -->
			<v-col cols="12" md="9" class="h-100 pa-0 purchase-editor-column">
				<v-card class="h-100 d-flex flex-column pos-themed-card" flat>
					<v-card-title class="purchase-title-bar bg-primary text-white d-flex align-center ga-2">
						<div>
							<div class="text-subtitle-1 font-weight-bold">
								{{ __("Purchase Order Draft") }}
							</div>
							<div class="text-caption purchase-title-bar__subtitle">
								{{
									__(
										"Build the order now; an authorized administrator can submit it later.",
									)
								}}
							</div>
						</div>
						<v-chip
							v-if="purchaseOrderName"
							size="small"
							color="white"
							variant="tonal"
							prepend-icon="mdi-file-document-edit-outline"
						>
							{{ purchaseOrderName }}
						</v-chip>
						<v-spacer></v-spacer>
						<v-btn
							icon="mdi-delete"
							variant="text"
							color="white"
							@click="clearPurchaseForm"
							:title="__('Clear All')"
							:aria-label="__('Clear all purchase order items')"
							data-pos-keyboard-target
							:disabled="entitlementStatus.read_only"
						></v-btn>
					</v-card-title>

					<v-card-text
						class="purchase-editor-body flex-grow-1 pa-3"
						:class="{ 'purchase-write-locked': entitlementStatus.read_only }"
					>
						<!-- Header Section -->
						<PurchaseHeader
							v-model:supplier="supplier"
							v-model:warehouse="warehouse"
							v-model:transactionDate="transactionDate"
							v-model:scheduleDate="scheduleDate"
							v-model:receiveNow="receiveNow"
							v-model:createInvoice="createInvoice"
							:supplierOptions="supplierOptions"
							:supplierLoading="supplierLoading"
							:warehouseOptions="warehouseOptions"
							:warehouseLoading="warehouseLoading"
							:allowCreateSupplier="allowCreateSupplier"
							:receiveDisabled="receiptComplete"
							:createInvoiceDisabled="invoiceComplete"
							:posProfile="pos_profile"
							@search-supplier="handleSupplierSearch"
							@create-supplier="supplierDialog = true"
						/>

						<v-divider class="mb-2"></v-divider>

						<!-- Items Table Section -->
						<PurchaseItemsTable
							:headers="itemHeaders"
							:items="purchaseItems"
							:currencySymbol="currencySymbol(priceListCurrency || supplierCurrency)"
							:receiveNow="receiveNow"
							:formatCurrency="formatCurrency"
							:formatNumber="formatNumber"
							@update-uom="({ item, value }) => updateItemUom(item, value)"
							@update-qty="({ item, value }) => updateItemQty(item, value)"
							@update-rate="({ item, value }) => updateItemRate(item, value)"
							@update-received-qty="({ item, value }) => updateItemReceivedQty(item, value)"
							@remove-item="removeItem"
						/>

						<v-alert v-if="errorMessage" type="error" density="compact" class="mt-2">
							{{ errorMessage }}
						</v-alert>
					</v-card-text>

					<div class="purchase-action-bar">
						<div class="purchase-action-bar__totals">
							<span class="purchase-action-bar__label">{{ __("Total") }}</span>
							<strong>
								{{ currencySymbol(priceListCurrency || supplierCurrency) }}
								{{ formatCurrency(totalAmount) }}
							</strong>
							<span class="purchase-action-bar__meta">
								{{ purchaseItems.length }} {{ __("items") }} &middot;
								{{ formatNumber(totalQty) }} {{ __("qty") }}
							</span>
						</div>
						<div class="purchase-action-bar__buttons">
							<v-btn
								variant="outlined"
								prepend-icon="mdi-plus"
								class="purchase-summary-btn"
								data-pos-keyboard-target
								:disabled="entitlementStatus.read_only"
								@click="clearPurchaseForm"
							>
								{{ __("New") }}
							</v-btn>
							<v-btn
								color="primary"
								variant="flat"
								prepend-icon="mdi-shield-check-outline"
								class="purchase-summary-btn"
								:disabled="saveAndClearDisabled"
								data-pos-keyboard-target
								@click="prepareSubmitAuthorization"
							>
								{{ __("Authorize Submit") }}
							</v-btn>
							<v-btn
								theme="dark"
								variant="flat"
								prepend-icon="mdi-content-save"
								class="purchase-summary-btn purchase-action-btn--save"
								@click="saveDraft"
								:loading="draftSaveLoading"
								:disabled="saveAndClearDisabled"
								data-pos-keyboard-target
							>
								{{ purchaseOrderName ? __("Update Draft") : __("Save Draft") }}
							</v-btn>
							<v-btn
								theme="dark"
								variant="flat"
								prepend-icon="mdi-tray-full"
								class="purchase-summary-btn purchase-action-btn--drafts"
								@click="draftDialog = true"
								:disabled="submitLoading || draftSaveLoading"
								data-pos-keyboard-target
							>
								{{ __("Purchase Orders") }}
							</v-btn>
							<v-btn
								theme="dark"
								variant="flat"
								prepend-icon="mdi-folder-search-outline"
								class="purchase-summary-btn purchase-action-btn--management"
								@click="managementDialog = true"
								:disabled="submitLoading || draftSaveLoading"
								data-pos-keyboard-target
							>
								{{ __("Submitted & Receiving") }}
							</v-btn>
						</div>
					</div>
				</v-card>
			</v-col>
		</v-row>

		<PurchaseDraftDialog
			v-model="draftDialog"
			:pos-profile="pos_profile"
			:warehouse-options="warehouseOptions"
			@select="handleDraftSelected"
		/>

		<PurchaseManagementDialog
			v-model="managementDialog"
			:pos-profile="pos_profile"
			:warehouse-options="warehouseOptions"
			:read-only="entitlementStatus.read_only"
		/>

		<PurchaseAuthorizationDialog
			v-model="submitAuthorizationDialog"
			:title="__('Submit Purchase Order')"
			:description="__('This submits the ERPNext Purchase Order and locks draft editing.')"
			:document-name="purchaseOrderName || ''"
			:required-role="__('Purchase Manager')"
			:confirm-label="__('Submit Order')"
			:loading="submitLoading"
			:error="submitAuthorizationError"
			@submit="handleAuthorizedSubmit"
			@cancel="resetSubmitAuthorization"
		/>

		<!-- Supplier Dialog -->
		<SupplierDialog
			v-model="supplierDialog"
			:groups="supplierGroups"
			:posProfile="pos_profile"
			@created="handleSupplierCreated"
			@error="(msg) => toastStore.show({ title: msg, color: 'error' })"
		/>
	</div>
</template>

<script>
import format, { normalizeDateForBackend } from "../../../format";
import { useUIStore } from "../../../stores/uiStore.js";
import { getOpeningStorage } from "../../../../offline/index";
import { useToastStore } from "../../../stores/toastStore";
import { usePurchaseOrder } from "../../../composables/pos/payments/usePurchaseOrder";
import ItemsSelector from "../items/ItemsSelector.vue";
import PurchaseDraftDialog from "./PurchaseDraftDialog.vue";
import PurchaseManagementDialog from "./PurchaseManagementDialog.vue";
import SupplierDialog from "../dialogs/purchase/SupplierDialog.vue";
import PurchaseHeader from "./PurchaseHeader.vue";
import PurchaseItemsTable from "./PurchaseItemsTable.vue";
import PurchaseAuthorizationDialog from "./PurchaseAuthorizationDialog.vue";
import { computed, ref, watch, onMounted, onBeforeUnmount, inject } from "vue";
import { focusFirstKeyboardTarget, moveFocusByArrow } from "../../../utils/keyboardNavigation";
import { extractPurchaseServerError, purchaseCurrencySymbol } from "./purchaseFormatting";

export default {
	mixins: [format],
	components: {
		ItemsSelector,
		PurchaseDraftDialog,
		PurchaseManagementDialog,
		SupplierDialog,
		PurchaseHeader,
		PurchaseItemsTable,
		PurchaseAuthorizationDialog,
	},
	setup() {
		const uiStore = useUIStore();
		const toastStore = useToastStore();
		const eventBus = inject("eventBus");
		const workspaceRoot = ref(null);

		const pos_profile = ref({});
		const receiveNow = ref(false);

		const {
			purchaseItems,
			purchaseOrderName,
			purchaseOrderModified,
			supplier,
			warehouse,
			transactionDate,
			scheduleDate,
			createInvoice,
			supplierCurrency,
			supplierPriceList,
			priceListCurrency,
			totalAmount,
			submitLoading,
			errorMessage,
			onAddItem,
			fetchSupplierInfo,
			updateItemUom,
			updateItemQty,
			updateItemRate,
			updateItemReceivedQty,
			removeItem,
			resetForm,
			generateLineId,
		} = usePurchaseOrder({
			posProfile: pos_profile,
			receiveNow: receiveNow,
			formatFloat: (val, prec) => format.methods.formatFloat.call({ currency_precision: 2 }, val, prec),
		});

		const supplierOptions = ref([]);
		const supplierLoading = ref(false);
		const supplierDialog = ref(false);
		const draftDialog = ref(false);
		const managementDialog = ref(false);
		const draftSaveLoading = ref(false);
		const submitAuthorizationDialog = ref(false);
		const submitAuthorizationError = ref("");
		const submitRequestId = ref("");
		const supplierGroups = ref([]);
		const warehouseOptions = ref([]);
		const warehouseLoading = ref(false);
		const purchaseOrderProgress = ref({});
		const defaultBuyingPriceList = ref("");
		const entitlementStatus = ref({ active: true, read_only: false, reason: "" });
		const totalQty = computed(() =>
			purchaseItems.value.reduce((sum, item) => sum + (Number(item.qty) || 0), 0),
		);
		const receiptComplete = computed(() => !!purchaseOrderProgress.value?.receipt_complete);
		const invoiceComplete = computed(() => !!purchaseOrderProgress.value?.invoice_complete);
		const loadedSubmittedOrder = computed(
			() => Number(purchaseOrderProgress.value?.docstatus || 0) === 1,
		);
		const saveAndClearDisabled = computed(
			() =>
				entitlementStatus.value.read_only ||
				submitLoading.value ||
				draftSaveLoading.value ||
				!purchaseItems.value.length ||
				loadedSubmittedOrder.value,
		);

		const supplierSearchTimeout = ref(null);

		const handleSupplierSearch = (term) => {
			if (supplierSearchTimeout.value) clearTimeout(supplierSearchTimeout.value);
			supplierSearchTimeout.value = setTimeout(() => searchSuppliers(term), 300);
		};

		const searchSuppliers = async (searchText = "") => {
			supplierLoading.value = true;
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.purchase_orders.search_suppliers",
					args: { search_text: searchText, limit: 20 },
				});
				supplierOptions.value = Array.isArray(message) ? message : [];
				if (supplier.value) {
					const s = supplierOptions.value.find((s) => s.name === supplier.value);
					supplierCurrency.value = s?.default_currency || pos_profile.value.currency;
				}
			} catch (error) {
				console.error("Failed to fetch suppliers:", error);
			} finally {
				supplierLoading.value = false;
			}
		};

		const loadEntitlement = async () => {
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.purchase_orders.get_purchase_entitlement",
					args: {
						pos_profile: pos_profile.value,
						company: pos_profile.value?.company,
						claim_seat: 1,
					},
				});
				entitlementStatus.value = message || entitlementStatus.value;
			} catch (error) {
				entitlementStatus.value = {
					active: false,
					read_only: true,
					reason: extractPurchaseServerError(error, __("Unable to verify Purchasing access.")),
				};
			}
		};

		const loadSupplierGroups = async () => {
			try {
				const { message } = await frappe.call({
					method: "frappe.client.get_list",
					args: {
						doctype: "Supplier Group",
						fields: ["name"],
						filters: { is_group: 0 },
						limit_page_length: 500,
					},
				});
				supplierGroups.value = (message || []).map((row) => row.name);
			} catch (error) {
				console.error("Failed to load groups:", error);
			}
		};

		const loadWarehouses = async () => {
			warehouseLoading.value = true;
			try {
				const { message } = await frappe.call({
					method: "frappe.client.get_list",
					args: {
						doctype: "Warehouse",
						fields: ["name", "warehouse_name"],
						filters: { company: pos_profile.value.company, is_group: 0, disabled: 0 },
					},
				});
				warehouseOptions.value = message || [];
			} catch (error) {
				console.error("Failed to load warehouses:", error);
			} finally {
				warehouseLoading.value = false;
			}
		};

		const handleSupplierCreated = (message) => {
			supplierOptions.value.unshift(message);
			supplier.value = message.name;
			supplierDialog.value = false;
		};

		const clearPurchaseForm = () => {
			resetForm();
			purchaseOrderProgress.value = {};
		};

		const focusItemSearch = () =>
			focusFirstKeyboardTarget(
				workspaceRoot.value?.querySelector(".purchase-selector-column"),
				"input[type='search'], input",
			);

		const handleWorkspaceKeydown = (event) => {
			if (event.key === "F2") {
				event.preventDefault();
				focusItemSearch();
				return;
			}

			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				if (!saveAndClearDisabled.value) void saveDraft();
				return;
			}

			moveFocusByArrow(event, { root: workspaceRoot.value });
		};

		const validatePurchaseOrderForm = () => {
			if (!supplier.value) {
				errorMessage.value = __("Supplier is required.");
				return false;
			}
			if (!purchaseItems.value.length) {
				errorMessage.value = __("Please add at least one item.");
				return false;
			}
			if (!transactionDate.value || !scheduleDate.value) {
				errorMessage.value = __("Supplier and dates are required.");
				return false;
			}
			errorMessage.value = "";
			return true;
		};

		const extractServerError = (error) =>
			extractPurchaseServerError(error, __("Unable to create purchase order"));

		const buildPurchaseOrderPayload = () => {
			const resolvedSupplier =
				typeof supplier.value === "object" && supplier.value !== null
					? supplier.value.name || supplier.value.supplier_name || ""
					: supplier.value;

			return {
				purchase_order: purchaseOrderName.value,
				expected_modified: purchaseOrderModified.value,
				supplier: resolvedSupplier,
				company: pos_profile.value.company,
				warehouse: warehouse.value,
				currency: supplierCurrency.value,
				buying_price_list: supplierPriceList.value,
				transaction_date: normalizeDateForBackend(transactionDate.value),
				schedule_date: normalizeDateForBackend(scheduleDate.value),
				submit: 0,
				pos_profile: pos_profile.value,
				items: purchaseItems.value.map((item) => ({
					name: item.name,
					item_code: item.item_code,
					item_name: item.item_name,
					stock_uom: item.stock_uom,
					uom: item.uom,
					conversion_factor: item.conversion_factor,
					qty: item.qty,
					rate: item.rate,
					warehouse: warehouse.value || item.warehouse,
				})),
			};
		};

		const saveDraft = async () => {
			if (!validatePurchaseOrderForm()) {
				return false;
			}

			draftSaveLoading.value = true;
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.purchase_orders.create_purchase_order",
					args: { data: buildPurchaseOrderPayload() },
				});
				if (message?.purchase_order) {
					const savedName = message.purchase_order;
					purchaseOrderName.value = savedName;
					purchaseOrderModified.value = message.modified || purchaseOrderModified.value;
					(message.items || []).forEach((savedRow, index) => {
						if (purchaseItems.value[index]) {
							purchaseItems.value[index].name = savedRow.name;
						}
					});
					toastStore.show({
						title: __("Purchase Order {0} saved as draft", [savedName]),
						color: "success",
					});
					return true;
				}
				return false;
			} catch (error) {
				errorMessage.value = extractServerError(error);
				toastStore.show({ title: errorMessage.value, color: "error" });
				return false;
			} finally {
				draftSaveLoading.value = false;
			}
		};

		const createRequestId = (action) => {
			const suffix =
				globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			return `purchase-${action}-${suffix}`;
		};

		const prepareSubmitAuthorization = async () => {
			if (!(await saveDraft())) return;
			submitAuthorizationError.value = "";
			submitRequestId.value = createRequestId("submit");
			submitAuthorizationDialog.value = true;
		};

		const resetSubmitAuthorization = () => {
			if (submitLoading.value) return;
			submitAuthorizationDialog.value = false;
			submitAuthorizationError.value = "";
			submitRequestId.value = "";
		};

		const handleAuthorizedSubmit = async ({ authorizationPin }) => {
			if (!purchaseOrderName.value || submitLoading.value) return;
			submitLoading.value = true;
			submitAuthorizationError.value = "";
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.purchase_orders.process_purchase_management_action",
					args: {
						data: {
							purchase_order: purchaseOrderName.value,
							action: "submit",
							pos_profile: pos_profile.value,
							company: pos_profile.value?.company,
							expected_modified: purchaseOrderModified.value,
							client_request_id: submitRequestId.value,
							authorization_pin: authorizationPin,
						},
					},
				});
				toastStore.show({
					title: __("Purchase Order {0} submitted by {1}", [
						message?.purchase_order || purchaseOrderName.value,
						message?.authorized_by_name || message?.authorized_by || __("authorized user"),
					]),
					color: "success",
				});
				submitAuthorizationDialog.value = false;
				submitAuthorizationError.value = "";
				submitRequestId.value = "";
				clearPurchaseForm();
				managementDialog.value = true;
			} catch (error) {
				submitAuthorizationError.value = extractServerError(error);
			} finally {
				submitLoading.value = false;
			}
		};

		const formatDateForPicker = (value) => {
			const normalized = normalizeDateForBackend(value);
			if (!normalized) return null;
			const [year, month, day] = normalized.split("-");
			return `${day}-${month}-${year}`;
		};

		const handleDraftSelected = async (draft) => {
			if (!draft) return;

			purchaseOrderName.value = draft.name || null;
			purchaseOrderModified.value = draft.modified || null;
			purchaseOrderProgress.value = {
				docstatus: Number(draft.docstatus || 0),
				per_received: Number(draft.per_received || 0),
				per_billed: Number(draft.per_billed || 0),
				has_receipt: !!draft.has_receipt,
				has_invoice: !!draft.has_invoice,
				receipt_complete: !!draft.receipt_complete,
				invoice_complete: !!draft.invoice_complete,
				receipt_partial: !!draft.receipt_partial,
				invoice_partial: !!draft.invoice_partial,
			};
			supplier.value = draft.supplier || null;
			warehouse.value =
				draft.set_warehouse ||
				(draft.items || []).find((item) => item.warehouse)?.warehouse ||
				pos_profile.value?.warehouse ||
				null;
			transactionDate.value = formatDateForPicker(draft.transaction_date);
			scheduleDate.value = formatDateForPicker(draft.schedule_date || draft.transaction_date);
			supplierCurrency.value = draft.currency || pos_profile.value?.currency || null;
			supplierPriceList.value = draft.buying_price_list || supplierPriceList.value;
			priceListCurrency.value = draft.currency || priceListCurrency.value;
			receiveNow.value = false;
			createInvoice.value = false;
			errorMessage.value = "";

			purchaseItems.value = (draft.items || []).map((item) => {
				const conversionFactor = Number(item.conversion_factor || 1) || 1;
				const rate = Number(item.rate || 0);
				const pendingReceiptQty = Number(item.pending_receipt_qty ?? item.qty ?? 0);
				const pendingBillQty = Number(item.pending_bill_qty ?? item.qty ?? 0);
				const visibleQty =
					Number(draft.docstatus || 0) === 1
						? Math.max(pendingReceiptQty, pendingBillQty)
						: Number(item.qty || 0);
				return {
					line_id: generateLineId(),
					name: item.name,
					item_code: item.item_code,
					item_name: item.item_name || item.item_code,
					stock_uom: item.stock_uom,
					item_group: item.item_group,
					item_uoms: item.item_uoms?.length
						? item.item_uoms
						: [{ uom: item.uom || item.stock_uom, conversion_factor: conversionFactor }],
					uom: item.uom || item.stock_uom,
					conversion_factor: conversionFactor,
					qty: visibleQty,
					rate,
					stock_uom_rate: conversionFactor ? rate / conversionFactor : rate,
					standard_rate: Number(item.standard_rate || 0),
					received_qty: pendingReceiptQty,
					receivedQtyManual: false,
					discount_percentage: Number(item.discount_percentage || 0),
					discount_amount: Number(item.discount_amount || 0),
					warehouse: item.warehouse,
					ordered_qty: Number(item.ordered_qty || item.qty || 0),
					pending_receipt_qty: pendingReceiptQty,
					billed_qty: Number(item.billed_qty || 0),
					pending_bill_qty: pendingBillQty,
					source_docstatus: Number(draft.docstatus || 0),
				};
			});

			if (draft.supplier) {
				await fetchSupplierInfo(draft.supplier);
			}

			toastStore.show({ title: __("Purchase Order draft loaded"), color: "success" });
		};

		onMounted(async () => {
			const cachedData = getOpeningStorage();
			const withPaymentMethods = (profile) => {
				if (!profile) return profile;
				if (profile.payments?.length) return profile;
				const payments = (cachedData?.payments_method || []).filter(
					(row) => row.parent === profile.name,
				);
				return payments.length ? { ...profile, payments } : profile;
			};
			if (cachedData?.pos_profile) {
				pos_profile.value = withPaymentMethods(cachedData.pos_profile);
			}

			watch(
				() => uiStore.posProfile,
				(p) => {
					if (p) pos_profile.value = withPaymentMethods(p);
				},
				{ immediate: true },
			);
			watch(supplier, async (val) => {
				if (val) {
					const info = await fetchSupplierInfo(val);
					eventBus?.emit?.("update_buying_price_list", {
						price_list: info?.buying_price_list || defaultBuyingPriceList.value || null,
						supplier: val,
					});
				} else {
					supplierCurrency.value = pos_profile.value.currency;
					eventBus?.emit?.("update_buying_price_list", null);
				}
			});

			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.purchase_orders.get_buying_price_list",
				});
				defaultBuyingPriceList.value = message || "";
			} catch (e) {
				console.error("Failed price list load", e);
			}

			clearPurchaseForm();
			await loadEntitlement();
			await Promise.all([searchSuppliers(""), loadSupplierGroups(), loadWarehouses()]);
		});

		onBeforeUnmount(() => {
			eventBus?.emit?.("update_buying_price_list", null);
		});

		return {
			workspaceRoot,
			pos_profile,
			receiveNow,
			purchaseItems,
			purchaseOrderName,
			purchaseOrderModified,
			supplier,
			warehouse,
			transactionDate,
			scheduleDate,
			createInvoice,
			supplierCurrency,
			supplierPriceList,
			defaultBuyingPriceList,
			entitlementStatus,
			priceListCurrency,
			totalAmount,
			totalQty,
			receiptComplete,
			invoiceComplete,
			saveAndClearDisabled,
			submitLoading,
			draftSaveLoading,
			errorMessage,
			onAddItem,
			fetchSupplierInfo,
			updateItemUom,
			updateItemQty,
			updateItemRate,
			updateItemReceivedQty,
			removeItem,
			resetForm,
			clearPurchaseForm,
			handleWorkspaceKeydown,
			supplierOptions,
			supplierLoading,
			supplierDialog,
			supplierGroups,
			warehouseOptions,
			warehouseLoading,
			draftDialog,
			managementDialog,
			submitAuthorizationDialog,
			submitAuthorizationError,
			handleSupplierSearch,
			handleSupplierCreated,
			saveDraft,
			prepareSubmitAuthorization,
			resetSubmitAuthorization,
			handleAuthorizedSubmit,
			handleDraftSelected,
			toastStore,
		};
	},
	computed: {
		allowCreateSupplier() {
			return (
				!this.entitlementStatus?.read_only && !!this.pos_profile?.posa_allow_create_purchase_suppliers
			);
		},
		itemHeaders() {
			const h = [
				{ title: __("Item"), key: "item_name", align: "start", width: "35%" },
				{ title: __("UOM"), key: "uom", align: "center", width: "15%" },
				{ title: __("Qty"), key: "qty", align: "center", width: "15%" },
				{ title: __("Rate"), key: "rate", align: "center", width: "15%" },
			];
			if (this.receiveNow)
				h.push({ title: __("Received"), key: "received_qty", align: "center", width: "10%" });
			h.push(
				{ title: __("Amount"), key: "amount", align: "end", width: "10%" },
				{ title: "", key: "actions", align: "center", width: "50px" },
			);
			return h;
		},
	},
	methods: {
		formatNumber(v) {
			return this.formatFloat(v, 2);
		},
		currencySymbol(c) {
			return purchaseCurrencySymbol(c || this.pos_profile.currency);
		},
	},
};
</script>

<style scoped>
.purchase-workspace {
	display: flex;
	flex-direction: column;
	min-height: 0;
	overflow: hidden;
}

.purchase-workspace__body {
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
}

.purchase-selector-column,
.purchase-editor-column {
	min-height: 0;
	overflow: hidden;
}

.purchase-write-locked {
	pointer-events: none;
	filter: grayscale(0.35);
	opacity: 0.68;
}

.purchase-title-bar {
	min-height: 52px;
	padding: 6px 12px !important;
}

.purchase-title-bar__subtitle {
	opacity: 0.82;
}

.purchase-editor-body {
	min-height: 0;
	overflow-y: auto;
}

.cursor-pointer {
	cursor: pointer;
}

.purchase-action-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 8px 12px;
	border-top: 1px solid var(--pos-border);
	background: var(--pos-surface-raised);
	background: color-mix(in srgb, var(--pos-surface-raised) 94%, rgb(var(--v-theme-primary)) 6%);
}

.purchase-action-bar__totals {
	display: grid;
	gap: 2px;
	min-width: 210px;
}

.purchase-action-bar__label,
.purchase-action-bar__meta {
	font-size: 0.78rem;
	color: var(--pos-text-muted);
}

.purchase-action-bar__totals strong {
	font-size: 1.25rem;
	line-height: 1.2;
	color: var(--pos-text-primary);
}

.purchase-action-bar__buttons {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	flex: 1 1 auto;
	margin-inline-start: auto;
}

.purchase-summary-btn {
	min-height: 40px !important;
	text-transform: none !important;
	transition: all 0.2s ease !important;
	position: relative;
	overflow: hidden;
	border-radius: 4px !important;
	color: #fff !important;
	letter-spacing: 0 !important;
}

.purchase-summary-btn :deep(.v-btn__content) {
	white-space: normal !important;
	transition: all 0.2s ease;
	color: #fff !important;
	font-weight: 700;
	opacity: 1 !important;
}

.purchase-summary-btn :deep(.v-btn__prepend) {
	color: #fff !important;
	opacity: 1 !important;
}

.purchase-action-btn--save {
	background: #ff6333 !important;
	box-shadow: 0 2px 8px rgba(255, 99, 51, 0.28) !important;
}

.purchase-action-btn--drafts {
	background: #ffc107 !important;
	box-shadow: 0 2px 8px rgba(255, 193, 7, 0.25) !important;
}

.purchase-action-btn--management {
	background: #673ab7 !important;
	box-shadow: 0 2px 8px rgba(103, 58, 183, 0.25) !important;
}

.purchase-action-btn--pay {
	background: linear-gradient(135deg, #4caf50, #45a049) !important;
	box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3) !important;
}

.purchase-summary-btn.v-btn--disabled {
	opacity: 0.72 !important;
}

.purchase-summary-btn.v-btn--disabled :deep(.v-btn__overlay) {
	opacity: 0 !important;
}

.purchase-summary-btn:hover {
	transform: translateY(-1px);
	box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15) !important;
}

.purchase-summary-btn:active {
	transform: translateY(0);
}

.purchase-summary-btn :deep(.v-btn__overlay),
.purchase-summary-btn :deep(.v-btn__underlay) {
	display: none !important;
}

@media (max-width: 720px) {
	.purchase-action-bar {
		align-items: stretch;
		flex-direction: column;
	}

	.purchase-action-bar__buttons {
		flex: 1 1 auto;
		width: 100%;
		margin-inline-start: 0;
	}

	.purchase-summary-btn {
		min-height: 42px !important;
		font-size: 0.85rem !important;
	}

	.purchase-pay-btn {
		min-height: 50px !important;
		font-size: 0.98rem !important;
	}
}
</style>
