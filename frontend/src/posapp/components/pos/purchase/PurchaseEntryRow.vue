<template>
	<tr ref="entryRow" class="purchase-entry-row" data-testid="purchase-entry-row">
		<td
			v-for="header in headers"
			:key="header.key"
			:class="{ 'purchase-entry-row__item-cell': header.key === 'item_name' }"
		>
			<label v-if="header.key === 'item_name'" class="purchase-entry-row__editor">
				<v-icon icon="mdi-magnify" size="18" />
				<input
					:value="modelValue"
					type="search"
					class="purchase-entry-row__input"
					data-testid="purchase-item-entry"
					data-pos-keyboard-target="item-search"
					:disabled="disabled"
					:aria-label="__('Scan barcode or search purchase item by name or code')"
					:placeholder="__('Scan or search item')"
					autocomplete="off"
					spellcheck="false"
					@input="updateValue"
					@keydown="handleKeydown"
				/>
				<kbd>F2</kbd>
			</label>
			<span v-else class="purchase-entry-row__placeholder" aria-hidden="true">-</span>
		</td>
	</tr>
</template>

<script setup lang="ts">
import { ref } from "vue";

defineProps<{
	headers: Array<{ key?: string }>;
	modelValue: string;
	disabled?: boolean;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: string];
	submit: [query: string];
	navigateBack: [];
	navigateForward: [];
}>();
const entryRow = ref<HTMLTableRowElement | null>(null);
const __ = window.__ || ((value: string) => value);
const getInput = () =>
	entryRow.value?.querySelector<HTMLInputElement>('[data-testid="purchase-item-entry"]') || null;

const updateValue = (event: Event) => {
	emit("update:modelValue", (event.target as HTMLInputElement | null)?.value || "");
};

const handleKeydown = (event: KeyboardEvent) => {
	if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey) {
		event.preventDefault();
		event.stopPropagation();
		emit("navigateForward");
		return;
	}
	if ((event.key === "Tab" && event.shiftKey) || event.key === "ArrowUp") {
		event.preventDefault();
		event.stopPropagation();
		emit("navigateBack");
		return;
	}
	if (event.key === "Enter") {
		event.preventDefault();
		event.stopPropagation();
		const query = (event.currentTarget as HTMLInputElement | null)?.value.trim() || "";
		if (query) emit("submit", query);
	}
};

const focus = (options: FocusOptions = {}) => getInput()?.focus(options);
const select = () => getInput()?.select();
defineExpose({ focus, select });
</script>

<style scoped>
.purchase-entry-row {
	height: var(--purchase-grid-row-height, 36px);
	background: var(--pos-surface-muted);
}

.purchase-entry-row td {
	height: var(--purchase-grid-row-height, 36px) !important;
	padding: 2px 8px !important;
	text-align: center;
	border-bottom: 1px solid var(--pos-border-light);
}

.purchase-entry-row__item-cell {
	text-align: start !important;
}

.purchase-entry-row__editor {
	display: flex;
	align-items: center;
	gap: 7px;
	width: 100%;
	height: 30px;
	padding: 2px 7px;
	border: 2px solid rgb(var(--v-theme-primary));
	border-radius: 4px;
	background: var(--pos-surface-raised);
	color: var(--pos-text-primary);
	cursor: text;
}

.purchase-entry-row__editor:focus-within {
	outline: 3px solid rgba(var(--v-theme-primary), 0.24);
	outline-offset: 1px;
}

.purchase-entry-row__input {
	min-width: 0;
	flex: 1;
	border: 0;
	outline: 0;
	background: transparent;
	color: inherit;
	font: inherit;
}

.purchase-entry-row__input::placeholder {
	color: var(--pos-text-muted);
	opacity: 1;
}

.purchase-entry-row__editor kbd {
	padding: 1px 5px;
	border: 1px solid var(--pos-border);
	border-radius: 3px;
	background: var(--pos-surface-muted);
	color: var(--pos-text-primary);
	font-size: 0.7rem;
}

.purchase-entry-row__placeholder {
	color: var(--pos-text-muted);
}
</style>
