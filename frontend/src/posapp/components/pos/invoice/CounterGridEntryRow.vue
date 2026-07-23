<template>
	<tr ref="entryRow" class="counter-grid-entry-row" data-testid="counter-grid-entry-row" role="row">
		<td
			v-for="column in columns"
			:key="column.key"
			class="counter-grid-entry-cell"
			:class="{ 'counter-grid-entry-cell--item': column.key === 'item_name' }"
			role="gridcell"
			:data-column-key="column.key"
		>
			<span
				v-if="column.key === 'data-table-expand'"
				class="counter-grid-entry-placeholder"
				aria-hidden="true"
				>-</span
			>
			<label v-else-if="column.key === 'item_name'" class="counter-grid-entry-editor">
				<v-icon icon="mdi-magnify" size="18" />
				<input
					:value="modelValue"
					type="search"
					class="counter-grid-entry-input"
					data-testid="counter-grid-item-entry"
					data-pos-keyboard-target="item-search"
					:aria-label="__('Scan barcode or search item by name, code, or generic')"
					:placeholder="__('Scan or search item')"
					autocomplete="off"
					spellcheck="false"
					@input="updateValue"
					@keydown="handleKeydown"
				/>
				<kbd>F2</kbd>
			</label>
			<span v-else class="counter-grid-entry-placeholder" aria-hidden="true">-</span>
		</td>
	</tr>
</template>

<script setup lang="ts">
import { ref } from "vue";

defineProps<{
	columns: Array<{ key?: string }>;
	modelValue: string;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: string];
	submit: [query: string];
	navigateBack: [method: "arrow-up" | "shift-tab"];
	navigateForward: [];
	navigatePay: [];
}>();
const entryRow = ref<HTMLTableRowElement | null>(null);
const __ = window.__ || ((value: string) => value);
const getInput = () =>
	entryRow.value?.querySelector<HTMLInputElement>('[data-testid="counter-grid-item-entry"]') || null;

const updateValue = (event: Event) => {
	emit("update:modelValue", (event.target as HTMLInputElement | null)?.value || "");
};

const handleKeydown = (event: KeyboardEvent) => {
	if (
		event.key === "ArrowLeft" &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.shiftKey &&
		!(event.currentTarget as HTMLInputElement | null)?.value
	) {
		event.preventDefault();
		event.stopPropagation();
		emit("navigatePay");
		return;
	}
	if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
		event.preventDefault();
		event.stopPropagation();
		emit("navigateForward");
		return;
	}
	if ((event.key === "Tab" && event.shiftKey) || event.key === "ArrowUp") {
		event.preventDefault();
		event.stopPropagation();
		emit("navigateBack", event.key === "ArrowUp" ? "arrow-up" : "shift-tab");
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
.counter-grid-entry-row {
	height: 44px;
	background: #f8fbf9;
	border-top: 2px solid var(--rm-cg-line-strong);
}

.counter-grid-entry-cell {
	padding: 6px 10px;
	text-align: center;
	border-right: 1px solid #c9d5df;
	border-bottom: 1px solid var(--rm-cg-line);
	background: #fbfdfc;
	color: #52687a;
}

.counter-grid-entry-cell--item {
	padding: 5px 8px;
	text-align: start;
}

.counter-grid-entry-editor {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	min-height: 34px;
	padding: 4px 10px;
	border: 2px solid var(--rm-cg-focus);
	border-radius: 3px;
	background: #ffffff;
	color: #10263b;
	box-shadow: inset 0 1px 2px rgba(9, 37, 61, 0.12);
	text-align: start;
	cursor: text;
}

.counter-grid-entry-editor:focus-within {
	border-color: var(--rm-cg-focus);
	outline: 3px solid #b9dcfb;
	outline-offset: 1px;
}

.counter-grid-entry-input {
	min-width: 0;
	flex: 1;
	border: 0;
	outline: 0;
	background: transparent;
	color: #10263b;
	font: inherit;
	letter-spacing: 0;
}

.counter-grid-entry-input::placeholder {
	color: #52687a;
	opacity: 1;
}

.counter-grid-entry-input::-webkit-search-cancel-button {
	cursor: pointer;
}

.counter-grid-entry-editor kbd {
	padding: 1px 5px;
	border: 1px solid var(--rm-cg-line);
	border-radius: 3px;
	background: var(--rm-cg-surface-muted);
	color: #17364f;
	font: inherit;
	font-size: 0.72rem;
}
</style>
