<template>
	<div
		class="column-selector-container"
		:class="{ 'column-selector-container--compact': compact }"
		:data-testid="compact ? 'counter-grid-column-toolbar' : 'invoice-item-toolbar'"
	>
		<v-text-field
			v-if="showSearch"
			ref="itemSearchField"
			:model-value="itemSearch"
			@update:model-value="$emit('update:itemSearch', $event)"
			density="compact"
			variant="solo"
			color="primary"
			class="item-search-field pos-themed-input"
			:label="__('Search items or barcode')"
			prepend-inner-icon="mdi-magnify"
			hide-details
			clearable
			autocomplete="off"
			data-pos-arrow-enters-invoice-grid
			data-testid="invoice-item-filter"
		></v-text-field>
		<v-btn
			density="compact"
			variant="text"
			color="primary"
			prepend-icon="mdi-view-column-outline"
			@click="toggleColumnSelection"
			class="column-selector-btn"
			:class="{ 'column-selector-btn--compact': compact }"
			data-testid="invoice-column-settings"
		>
			{{ __("Columns") }}
		</v-btn>
		<v-dialog v-model="showColumnSelector" max-width="500px" transition="dialog-bottom-transition">
			<v-card class="pos-themed-card">
				<v-card-title class="text-h6 pa-4 d-flex align-center">
					<span>{{ __("Select Columns to Display") }}</span>
					<v-spacer></v-spacer>
					<v-btn
						icon="mdi-close"
						variant="text"
						density="compact"
						:aria-label="__('Close column selector')"
						@click="showColumnSelector = false"
					></v-btn>
				</v-card-title>
				<v-divider></v-divider>
				<v-card-text class="pa-4">
					<v-row dense>
						<v-col
							cols="12"
							v-for="column in availableColumns.filter((col) => !col.required)"
							:key="column.key"
						>
							<v-switch
								:model-value="isTempColumnSelected(column.key)"
								@update:model-value="(value) => setTempColumnSelection(column.key, value)"
								:label="column.title"
								hide-details
								density="compact"
								color="primary"
								class="column-switch mb-1"
								:disabled="column.required"
							></v-switch>
						</v-col>
					</v-row>
					<div class="text-caption mt-2">
						{{ __("Required columns cannot be hidden") }}
					</div>
				</v-card-text>
				<v-card-actions class="pa-4 pt-0">
					<v-btn color="error" variant="text" @click="cancelColumnSelection">{{
						__("Cancel")
					}}</v-btn>
					<v-spacer></v-spacer>
					<v-btn color="primary" variant="tonal" @click="updateSelectedColumns">{{
						__("Apply")
					}}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script setup>
import { ref } from "vue";

const props = defineProps({
	itemSearch: {
		type: String,
		default: "",
	},
	availableColumns: {
		type: Array,
		default: () => [],
	},
	selectedColumns: {
		type: Array,
		default: () => [],
	},
	showSearch: {
		type: Boolean,
		default: true,
	},
	compact: {
		type: Boolean,
		default: false,
	},
});

const emit = defineEmits(["update:itemSearch", "update:selectedColumns"]);

const showColumnSelector = ref(false);
const tempSelectedColumns = ref([]);
const itemSearchField = ref(null);

const toggleColumnSelection = () => {
	tempSelectedColumns.value = normalizeColumns(props.selectedColumns);
	showColumnSelector.value = true;
};

const cancelColumnSelection = () => {
	showColumnSelector.value = false;
};

const updateSelectedColumns = () => {
	emit("update:selectedColumns", normalizeColumns(tempSelectedColumns.value));
	showColumnSelector.value = false;
};

const focusSearch = () => {
	if (!props.showSearch) return false;
	itemSearchField.value?.focus?.();
	return true;
};

const normalizeColumns = (columns) =>
	Array.isArray(columns) ? [...new Set(columns.filter((column) => typeof column === "string"))] : [];

const isTempColumnSelected = (key) => tempSelectedColumns.value.includes(key);

const setTempColumnSelection = (key, selected) => {
	const next = new Set(tempSelectedColumns.value);
	if (selected) {
		next.add(key);
	} else {
		next.delete(key);
	}
	tempSelectedColumns.value = [...next];
};

defineExpose({
	focusSearch,
});
</script>

<style scoped>
.column-selector-container--compact {
	display: flex;
	align-items: center;
	justify-content: flex-end;
}
</style>
