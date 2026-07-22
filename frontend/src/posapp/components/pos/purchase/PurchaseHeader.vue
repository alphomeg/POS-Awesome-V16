<template>
	<v-container class="pa-0">
		<v-row dense class="mb-0 purchase-header-row">
			<v-col cols="12" md="4">
				<v-autocomplete
					:model-value="supplier"
					@update:model-value="$emit('update:supplier', $event)"
					:items="supplierOptions"
					item-title="supplier_name"
					item-value="name"
					:label="frappe._('Supplier')"
					density="compact"
					variant="outlined"
					color="primary"
					hide-details="auto"
					:loading="supplierLoading"
					@update:search="$emit('search-supplier', $event)"
					:custom-filter="() => true"
					:no-data-text="supplierLoading ? __('Loading suppliers...') : __('Suppliers not found')"
					class="pos-themed-input"
					clearable
				>
					<template #append-inner>
						<v-tooltip v-if="allowCreateSupplier" :text="__('Add new supplier')">
							<template #activator="{ props }">
								<v-icon
									v-bind="props"
									class="cursor-pointer"
									@mousedown.prevent.stop
									@click.stop="$emit('create-supplier')"
								>
									mdi-plus
								</v-icon>
							</template>
						</v-tooltip>
					</template>
				</v-autocomplete>
			</v-col>
			<v-col cols="12" md="3">
				<v-autocomplete
					:model-value="warehouse"
					@update:model-value="$emit('update:warehouse', $event)"
					:items="warehouseOptions"
					item-title="warehouse_name"
					item-value="name"
					:label="frappe._('Warehouse')"
					density="compact"
					variant="outlined"
					color="primary"
					hide-details="auto"
					clearable
					:loading="warehouseLoading"
					class="pos-themed-input"
				/>
			</v-col>
			<v-col cols="6" md="2">
				<VueDatePicker
					:model-value="transactionDate"
					@update:model-value="$emit('update:transactionDate', $event)"
					model-type="format"
					format="dd-MM-yyyy"
					:enable-time-picker="false"
					auto-apply
					:placeholder="frappe._('Posting Date')"
					class="pos-themed-input"
				/>
			</v-col>
			<v-col cols="6" md="3">
				<VueDatePicker
					:model-value="scheduleDate"
					@update:model-value="$emit('update:scheduleDate', $event)"
					model-type="format"
					format="dd-MM-yyyy"
					:enable-time-picker="false"
					auto-apply
					:placeholder="frappe._('Required By')"
					class="pos-themed-input"
				/>
			</v-col>
		</v-row>
	</v-container>
</template>

<script>
export default {
	props: {
		supplier: String,
		supplierOptions: Array,
		supplierLoading: Boolean,
		allowCreateSupplier: Boolean,
		warehouse: String,
		warehouseOptions: Array,
		warehouseLoading: Boolean,
		transactionDate: String,
		scheduleDate: String,
		receiveNow: Boolean,
		createInvoice: Boolean,
		receiveDisabled: Boolean,
		createInvoiceDisabled: Boolean,
		posProfile: Object,
	},
	emits: [
		"update:supplier",
		"update:warehouse",
		"update:transactionDate",
		"update:scheduleDate",
		"update:receiveNow",
		"update:createInvoice",
		"search-supplier",
		"create-supplier",
	],
};
</script>

<style scoped>
.purchase-header-row :deep(.v-field),
.purchase-header-row :deep(.dp__input) {
	min-height: 38px;
}
</style>
