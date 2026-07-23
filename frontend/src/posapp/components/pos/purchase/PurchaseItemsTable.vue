<template>
	<v-data-table
		ref="table"
		:headers="headers"
		:items="items"
		item-key="line_id"
		class="purchase-items-grid elevation-1 border rounded"
		density="compact"
		hide-default-footer
		:items-per-page="-1"
		fixed-header
		height="456"
		:data-visible-row-capacity="VISIBLE_ROW_CAPACITY"
		@keydown.capture="handleGridKeydown"
	>
		<template #no-data></template>

		<template v-slot:item.item_name="{ item }">
			<div class="purchase-item-identity" tabindex="0" data-pos-keyboard-target>
				<div class="font-weight-bold">{{ item.item_name }}</div>
				<div class="text-caption text-medium-emphasis">
					{{ item.item_code }}
				</div>
			</div>
		</template>

		<template v-slot:item.uom="{ item }">
			<div class="pos-table__editor-box uom-editor" @click.stop>
				<v-btn
					size="x-small"
					variant="flat"
					class="pos-table__editor-btn uom-arrow"
					@click.stop="changeUom(item, -1)"
					:disabled="!item.item_uoms || item.item_uoms.length <= 1"
					:aria-label="__('Previous unit of measure')"
				>
					<v-icon size="small">mdi-chevron-left</v-icon>
				</v-btn>
				<v-select
					:model-value="item.uom"
					@update:model-value="(val) => $emit('update-uom', { item, value: val })"
					:items="item.item_uoms || [{ uom: item.stock_uom, conversion_factor: 1 }]"
					item-title="uom"
					item-value="uom"
					density="compact"
					variant="outlined"
					class="pos-table__editor-input uom-select"
					:class="{ 'uom-display-mode': !item._isEditingUom }"
					hide-details
					data-pos-keyboard-target
					data-pos-keyboard-native-arrows
					@focus="item._isEditingUom = true"
					@blur="item._isEditingUom = false"
				></v-select>
				<v-btn
					size="x-small"
					variant="flat"
					class="pos-table__editor-btn uom-arrow"
					@click.stop="changeUom(item, 1)"
					:disabled="!item.item_uoms || item.item_uoms.length <= 1"
					:aria-label="__('Next unit of measure')"
				>
					<v-icon size="small">mdi-chevron-right</v-icon>
				</v-btn>
			</div>
		</template>

		<template v-slot:item.qty="{ item }">
			<div class="pos-table__qty-counter">
				<v-btn
					size="small"
					variant="flat"
					class="pos-table__qty-btn minus-btn qty-control-btn"
					@click.stop="$emit('update-qty', { item, value: item.qty - 1 })"
					:aria-label="__('Decrease quantity')"
				>
					<v-icon size="small">mdi-minus</v-icon>
				</v-btn>
				<div
					v-if="!item._isEditingQty"
					class="pos-table__qty-display"
					tabindex="0"
					role="button"
					data-pos-keyboard-target
					@click.stop="openQtyEdit(item)"
					@keydown.enter.stop.prevent="openQtyEdit(item)"
					@keydown.space.stop.prevent="openQtyEdit(item)"
				>
					{{ formatNumber(item.qty) }}
				</div>
				<v-text-field
					v-else
					v-model="item._editingQtyValue"
					density="compact"
					variant="outlined"
					class="pos-table__qty-input"
					@blur="closeQtyEdit(item)"
					@keydown.enter.prevent="closeQtyEdit(item)"
					@keydown.esc.prevent="cancelQtyEdit(item)"
					@click.stop
					autofocus
					type="number"
					min="0"
				></v-text-field>
				<v-btn
					size="small"
					variant="flat"
					class="pos-table__qty-btn plus-btn qty-control-btn"
					@click.stop="$emit('update-qty', { item, value: item.qty + 1 })"
					:aria-label="__('Increase quantity')"
				>
					<v-icon size="small">mdi-plus</v-icon>
				</v-btn>
			</div>
		</template>

		<template v-slot:item.rate="{ item }">
			<div class="pos-table__editor-box">
				<div
					v-if="!item._isEditingRate"
					class="pos-table__editor-display"
					tabindex="0"
					role="button"
					data-pos-keyboard-target
					@click.stop="openRateEdit(item)"
					@keydown.enter.stop.prevent="openRateEdit(item)"
					@keydown.space.stop.prevent="openRateEdit(item)"
				>
					<span class="currency-symbol">{{ currencySymbol }}</span>
					<span class="amount-value">{{ formatCurrency(item.rate) }}</span>
				</div>
				<v-text-field
					v-else
					v-model="item._editingRateValue"
					density="compact"
					variant="outlined"
					class="pos-table__editor-input"
					@blur="closeRateEdit(item)"
					@keydown.enter.prevent="closeRateEdit(item)"
					@keydown.esc.prevent="cancelRateEdit(item)"
					@click.stop
					autofocus
					type="number"
					min="0"
				></v-text-field>
			</div>
		</template>

		<template v-slot:item.received_qty="{ item }">
			<v-text-field
				v-if="receiveNow"
				density="compact"
				variant="outlined"
				hide-details
				type="number"
				min="0"
				:model-value="item.received_qty"
				@update:model-value="(val) => $emit('update-received-qty', { item, value: val })"
				class="pos-themed-input"
				style="width: 80px"
			></v-text-field>
		</template>

		<template v-slot:item.amount="{ item }">
			<div class="text-right font-weight-bold">
				{{ formatCurrency(item.qty * item.rate) }}
			</div>
		</template>

		<template v-slot:item.actions="{ item }">
			<v-btn
				icon="mdi-delete"
				variant="text"
				color="error"
				size="small"
				@click="$emit('remove-item', item)"
				:aria-label="__('Remove item')"
				data-pos-keyboard-target
			></v-btn>
		</template>

		<template #body.append>
			<PurchaseEntryRow
				ref="entryRow"
				v-model="entryQuery"
				:headers="headers"
				:disabled="disabled"
				@submit="$emit('search-item', $event)"
				@navigate-back="focusPreviousRow"
				@navigate-forward="$emit('navigate-forward')"
			/>
			<tr
				v-for="slot in emptyRowCount"
				:key="`empty-purchase-row-${slot}`"
				class="purchase-items-grid__empty-row"
				aria-hidden="true"
			>
				<td :colspan="headers.length"></td>
			</tr>
		</template>
	</v-data-table>
</template>

<script>
import PurchaseEntryRow from "./PurchaseEntryRow.vue";
import { moveFocusByArrow } from "../../../utils/keyboardNavigation";

export const VISIBLE_ROW_CAPACITY = 10;

export default {
	components: { PurchaseEntryRow },
	props: {
		headers: Array,
		items: Array,
		currencySymbol: String,
		receiveNow: Boolean,
		formatCurrency: Function,
		formatNumber: Function,
		disabled: Boolean,
	},
	emits: [
		"update-uom",
		"update-qty",
		"update-rate",
		"update-received-qty",
		"remove-item",
		"search-item",
		"navigate-forward",
	],
	data() {
		return { entryQuery: "" };
	},
	computed: {
		emptyRowCount() {
			return Math.max(VISIBLE_ROW_CAPACITY - this.items.length, 0);
		},
		VISIBLE_ROW_CAPACITY() {
			return VISIBLE_ROW_CAPACITY;
		},
	},
	methods: {
		focusEntry({ select = false } = {}) {
			this.$nextTick(() => {
				this.$refs.entryRow?.focus?.({ preventScroll: true });
				if (select) this.$refs.entryRow?.select?.();
			});
		},
		clearEntry() {
			this.entryQuery = "";
		},
		focusPreviousRow() {
			const targets = Array.from(
				this.$refs.table?.$el?.querySelectorAll?.(
					"tbody tr:not(.purchase-entry-row) [data-pos-keyboard-target]",
				) || [],
			).filter((element) => !element.disabled && element.offsetParent !== null);
			targets.at(-1)?.focus?.({ preventScroll: true });
		},
		handleGridKeydown(event) {
			moveFocusByArrow(event, { root: this.$refs.table?.$el || null });
		},
		changeUom(item, direction) {
			if (!item.item_uoms || item.item_uoms.length <= 1) return;
			const uoms = item.item_uoms.map((u) => u.uom);
			const currentIndex = uoms.indexOf(item.uom);
			let newIndex = currentIndex + direction;

			if (newIndex < 0) {
				newIndex = uoms.length - 1;
			} else if (newIndex >= uoms.length) {
				newIndex = 0;
			}

			const newUom = uoms[newIndex];
			if (newUom !== item.uom) {
				this.$emit("update-uom", { item, value: newUom });
			}
		},
		openQtyEdit(item) {
			item._isEditingQty = true;
			item._editingQtyValue = "";
		},
		closeQtyEdit(item) {
			if (item._isEditingQty) {
				if (item._editingQtyValue !== "" && item._editingQtyValue != null) {
					const val = parseFloat(item._editingQtyValue);
					if (!isNaN(val) && val >= 0) {
						this.$emit("update-qty", { item, value: val });
					}
				}
				item._isEditingQty = false;
			}
		},
		cancelQtyEdit(item) {
			item._editingQtyValue = "";
			item._isEditingQty = false;
		},
		openRateEdit(item) {
			item._isEditingRate = true;
			item._editingRateValue = "";
		},
		closeRateEdit(item) {
			if (item._isEditingRate) {
				if (item._editingRateValue !== "" && item._editingRateValue != null) {
					const val = parseFloat(item._editingRateValue);
					if (!isNaN(val) && val >= 0) {
						this.$emit("update-rate", { item, value: val });
					}
				}
				item._isEditingRate = false;
			}
		},
		cancelRateEdit(item) {
			item._editingRateValue = "";
			item._isEditingRate = false;
		},
	},
};
</script>

<style scoped>
.purchase-items-grid {
	--purchase-grid-header-height: 36px;
	--purchase-grid-row-height: 36px;
	background: var(--pos-surface-raised);
}

.purchase-items-grid :deep(.v-table__wrapper) {
	max-height: 456px;
	overflow-y: auto;
}

.purchase-items-grid :deep(.v-data-table-rows-no-data) {
	display: none;
}

.purchase-items-grid :deep(thead tr),
.purchase-items-grid :deep(thead th) {
	height: var(--purchase-grid-header-height) !important;
}

.purchase-items-grid :deep(tbody tr),
.purchase-items-grid :deep(tbody td) {
	height: var(--purchase-grid-row-height) !important;
}

.purchase-items-grid :deep(tbody td) {
	padding-block: 0 !important;
}

.purchase-items-grid__empty-row td {
	border-bottom: 1px solid var(--pos-border-light);
	border-bottom: 1px solid color-mix(in srgb, var(--pos-border-light) 60%, transparent);
	color: var(--pos-text-muted);
	font-size: 0.8rem;
	text-align: center;
}

.purchase-item-identity {
	min-width: 0;
	outline: none;
}

.purchase-item-identity:focus-visible,
.pos-table__qty-display:focus-visible,
.pos-table__editor-display:focus-visible {
	box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), 0.28);
	box-shadow: 0 0 0 3px color-mix(in srgb, rgb(var(--v-theme-primary)) 28%, transparent);
	outline: 2px solid rgb(var(--v-theme-primary));
	outline-offset: 1px;
}

.pos-table__qty-counter {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 2px;
	padding: 2px;
	min-width: 60px;
	max-width: 100px;
	width: auto;
	height: auto;
	background: var(--pos-surface-variant);
	border-radius: 8px;
	backdrop-filter: blur(10px);
	border: 1px solid var(--pos-border-light);
	transition: all 0.3s ease;
	margin: 0 auto;
	flex-shrink: 0;
	box-sizing: border-box;
}

.pos-table__qty-counter:hover {
	background: var(--pos-hover-bg);
	box-shadow: 0 4px 16px var(--pos-shadow);
	transform: translateY(-1px);
}

.pos-table__qty-display {
	min-width: 15px;
	max-width: 40px;
	width: auto;
	flex: 1 1 auto;
	text-align: center;
	font-weight: 600;
	padding: 0 2px;
	border-radius: 4px;
	background: var(--pos-primary-container);
	border: 1px solid var(--pos-primary-variant);
	color: var(--pos-primary);
	font-size: 0.75rem;
	transition: all 0.2s ease;
	box-shadow: 0 1px 3px var(--pos-shadow-light);
	display: flex;
	align-items: center;
	justify-content: center;
	height: 24px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	cursor: pointer;
}

.qty-control-btn {
	width: 24px !important;
	height: 24px !important;
	min-width: 24px !important;
	border-radius: 6px !important;
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
	box-shadow:
		0 2px 8px var(--pos-shadow-light),
		0 1px 3px var(--pos-shadow-light) !important;
	font-weight: 600 !important;
	backdrop-filter: blur(10px) !important;
	position: relative !important;
	overflow: hidden !important;
	flex-shrink: 0;
}

.qty-control-btn.minus-btn {
	background: var(--pos-button-warning-bg) !important;
	color: var(--pos-button-warning-text) !important;
	border: 2px solid var(--pos-button-warning-border) !important;
}

.qty-control-btn.plus-btn {
	background: var(--pos-button-success-bg) !important;
	color: var(--pos-button-success-text) !important;
	border: 2px solid var(--pos-button-success-border) !important;
}

.pos-table__qty-input {
	max-width: 80px;
	margin: 0 auto;
}
.pos-table__qty-input :deep(input) {
	text-align: center;
	font-weight: 600;
	-moz-appearance: textfield;
	appearance: textfield;
}
.pos-table__qty-input :deep(input::-webkit-outer-spin-button),
.pos-table__qty-input :deep(input::-webkit-inner-spin-button) {
	-webkit-appearance: none;
	appearance: none;
	margin: 0;
}
.pos-table__qty-input :deep(.v-input__control) {
	height: 24px;
}
.pos-table__qty-input :deep(.v-field__field) {
	height: 24px;
	padding: 0 4px;
}
.pos-table__qty-input :deep(.v-field__input) {
	padding: 0;
	min-height: 24px;
	font-size: 0.75rem;
}

.pos-table__editor-box {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 2px;
	padding: 2px;
	min-width: 60px;
	max-width: 100px;
	width: auto;
	height: auto;
	background: var(--pos-surface-variant);
	border-radius: 8px;
	border: 1px solid var(--pos-border-light);
	transition: all 0.3s ease;
	margin: 0 auto;
	flex-shrink: 0;
	box-sizing: border-box;
}

.pos-table__editor-box:hover {
	background: var(--pos-hover-bg);
	box-shadow: 0 4px 16px var(--pos-shadow);
	transform: translateY(-1px);
}

.pos-table__editor-display {
	min-width: 40px;
	max-width: 80px;
	width: auto;
	flex: 1 1 auto;
	text-align: center;
	font-weight: 600;
	padding: 0 2px;
	border-radius: 4px;
	background: var(--pos-primary-container);
	border: 1px solid var(--pos-primary-variant);
	color: var(--pos-primary);
	font-size: 0.75rem;
	transition: all 0.2s ease;
	box-shadow: 0 1px 3px var(--pos-shadow-light);
	display: flex;
	align-items: center;
	justify-content: center;
	height: 24px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	cursor: pointer;
}

.pos-table__editor-btn {
	width: 24px !important;
	height: 24px !important;
	min-width: 24px !important;
	border-radius: 6px !important;
}
.pos-table__editor-input {
	max-width: 80px;
}
.pos-table__editor-input :deep(.v-input__control) {
	height: 24px;
}
.pos-table__editor-input :deep(.v-field__field) {
	height: 24px;
	padding: 0 4px;
}
.pos-table__editor-input :deep(.v-field__input) {
	padding: 0;
	min-height: 24px;
	font-size: 0.75rem;
}
.pos-table__editor-input :deep(input) {
	text-align: center;
}

.uom-editor {
	gap: 2px;
}
.uom-arrow {
	flex-shrink: 0;
}
.uom-select {
	min-width: 40px;
}

.uom-display-mode :deep(.v-field__outline) {
	display: none;
}
.uom-display-mode :deep(.v-field) {
	background-color: transparent !important;
	border: none !important;
	box-shadow: none !important;
}
.uom-display-mode :deep(.v-field__input) {
	justify-content: center;
	padding: 0;
	font-weight: 600;
	color: var(--pos-primary);
}
.uom-display-mode :deep(.v-select__selection-text) {
	text-align: center;
	color: var(--pos-primary);
	font-size: 0.65rem;
	letter-spacing: -0.05em;
	white-space: nowrap;
	overflow: visible;
}
.uom-display-mode :deep(.v-field__append-inner) {
	display: none;
}

.currency-display {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	padding: 0;
	margin: 0;
}

.currency-display.right-aligned {
	justify-content: center;
}

.amount-value {
	font-weight: 500;
}

.currency-symbol {
	opacity: 0.7;
	margin-right: 2px;
	font-size: 0.85em;
}
</style>
