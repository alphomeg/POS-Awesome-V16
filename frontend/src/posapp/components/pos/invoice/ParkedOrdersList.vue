<template>
	<section
		ref="listRoot"
		class="drafts-list"
		tabindex="-1"
		:aria-label="title || __('Drafts')"
		data-pos-arrow-navigation-root="saved-drafts"
		@keydown="handleKeydown"
	>
		<div class="drafts-list__brand" data-test="drafts-retailmind-brand">
			<img class="drafts-list__brand-mark" :src="posLogo" alt="" aria-hidden="true" />
			<span>{{ POS_BRAND_NAME }}</span>
		</div>

		<div class="drafts-list__header">
			<div>
				<p class="drafts-list__eyebrow">{{ eyebrow || __("Ready to resume") }}</p>
				<h4 class="drafts-list__title">{{ title || __("Drafts") }}</h4>
				<p v-if="subtitle" class="drafts-list__subtitle">{{ subtitle }}</p>
			</div>
			<div class="drafts-list__actions">
				<span class="drafts-list__count">{{ parkedOrders.length }}</span>
				<v-btn
					v-if="showManageAll"
					size="small"
					variant="text"
					color="primary"
					data-test="drafts-manage-all"
					@click="$emit('manage-all')"
				>
					{{ __("Manage all") }}
				</v-btn>
			</div>
		</div>

		<div v-if="loading" class="drafts-list__empty drafts-list__empty--loading">
			<v-progress-circular indeterminate size="22" width="3" color="primary" />
			<strong>{{ loadingTitle || __("Loading records...") }}</strong>
		</div>
		<div v-else-if="parkedOrders.length" class="drafts-list__cards">
			<button
				v-for="(draft, index) in parkedOrders"
				:key="draft.name"
				:ref="(el) => setCardRef(el, index)"
				type="button"
				class="drafts-list__card"
				:class="{ 'drafts-list__card--selected': selectedIndex === index }"
				:tabindex="selectedIndex === index ? 0 : -1"
				:aria-current="selectedIndex === index ? 'true' : undefined"
				:data-test="`draft-list-card-${draft.name}`"
				@focus="selectedIndex = index"
				@mouseenter="selectedIndex = index"
				@keydown.stop="handleKeydown"
				@click="$emit('resume', draft)"
			>
				<div class="drafts-list__card-top">
					<strong>{{ draft.customer_name || __("Walk-in Customer") }}</strong>
					<span class="drafts-list__amount">
						{{ currencySymbol(draft.currency) }}{{ formatCurrency(draft.grand_total) }}
					</span>
				</div>
				<div class="drafts-list__meta">
					<span>{{ draft.name }}</span>
					<span>{{ draft.posting_date }}</span>
					<span>{{ draft.posting_time?.split(".")[0] || "" }}</span>
				</div>
			</button>
		</div>
		<div v-else class="drafts-list__empty">
			<strong>{{ emptyTitle || __("No records found") }}</strong>
			<span>{{ emptySubtitle || __("Try another source or refresh the list.") }}</span>
		</div>
	</section>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";
import { POS_BRAND_NAME } from "../../../config/branding";
import posLogo from "../pos.png";

const props = defineProps({
	parkedOrders: {
		type: Array,
		default: () => [],
	},
	formatCurrency: {
		type: Function,
		required: true,
	},
	currencySymbol: {
		type: Function,
		required: true,
	},
	showManageAll: {
		type: Boolean,
		default: false,
	},
	title: {
		type: String,
		default: "",
	},
	eyebrow: {
		type: String,
		default: "",
	},
	subtitle: {
		type: String,
		default: "",
	},
	emptyTitle: {
		type: String,
		default: "",
	},
	emptySubtitle: {
		type: String,
		default: "",
	},
	loading: {
		type: Boolean,
		default: false,
	},
	loadingTitle: {
		type: String,
		default: "",
	},
});

const emit = defineEmits(["resume", "manage-all", "close"]);

const __ = window.__;
const listRoot = ref(null);
const cardRefs = ref([]);
const selectedIndex = ref(0);

function clampSelectedIndex() {
	const maxIndex = props.parkedOrders.length - 1;
	if (maxIndex < 0) {
		selectedIndex.value = 0;
		return;
	}
	selectedIndex.value = Math.min(Math.max(selectedIndex.value, 0), maxIndex);
}

function setCardRef(el, index) {
	if (el) {
		cardRefs.value[index] = el;
	}
}

function focusSelectedDraft() {
	return nextTick(() => {
		clampSelectedIndex();
		const button = cardRefs.value[selectedIndex.value];
		if (button?.focus) {
			button.focus({ preventScroll: true });
			button.scrollIntoView?.({ block: "nearest" });
			return;
		}
		listRoot.value?.focus?.({ preventScroll: true });
	});
}

function focusFirstDraft() {
	selectedIndex.value = 0;
	return focusSelectedDraft();
}

function selectOffset(offset) {
	const count = props.parkedOrders.length;
	if (!count) {
		return;
	}
	selectedIndex.value = (selectedIndex.value + offset + count) % count;
	focusSelectedDraft();
}

function resumeSelectedDraft() {
	const draft = props.parkedOrders[selectedIndex.value];
	if (draft) {
		emit("resume", draft);
	}
}

function isManageAllTarget(target) {
	return Boolean(target?.closest?.('[data-test="drafts-manage-all"]'));
}

function trapTabFocus(event) {
	const focusRoot = listRoot.value?.closest?.("[data-drafts-focus-root]") || listRoot.value;
	const focusTargets = Array.from(
		focusRoot?.querySelectorAll?.(
			'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
		) || [],
	).filter((target) => target !== listRoot.value && !target.disabled && Number(target.tabIndex) >= 0);
	if (!focusTargets.length) {
		event.preventDefault();
		listRoot.value?.focus?.({ preventScroll: true });
		return;
	}

	event.preventDefault();
	const currentIndex = focusTargets.indexOf(document.activeElement);
	const direction = event.shiftKey ? -1 : 1;
	const nextIndex =
		currentIndex < 0
			? event.shiftKey
				? focusTargets.length - 1
				: 0
			: (currentIndex + direction + focusTargets.length) % focusTargets.length;
	focusTargets[nextIndex]?.focus?.({ preventScroll: true });
}

function handleKeydown(event) {
	if (event.key === "Tab") {
		trapTabFocus(event);
		return;
	}

	if (event.key === "Escape") {
		event.preventDefault();
		emit("close");
		return;
	}

	if (event.key === "ArrowLeft") {
		event.preventDefault();
		event.stopPropagation();
		emit("close");
		return;
	}

	if (event.key === "ArrowRight") {
		event.preventDefault();
		event.stopPropagation();
		focusSelectedDraft();
		return;
	}

	if (event.key === "ArrowDown") {
		event.preventDefault();
		selectOffset(1);
		return;
	}

	if (event.key === "ArrowUp") {
		event.preventDefault();
		selectOffset(-1);
		return;
	}

	if (event.key === "Home") {
		event.preventDefault();
		selectedIndex.value = 0;
		focusSelectedDraft();
		return;
	}

	if (event.key === "End") {
		event.preventDefault();
		selectedIndex.value = Math.max(0, props.parkedOrders.length - 1);
		focusSelectedDraft();
		return;
	}

	if ((event.key === "Enter" || event.key === " ") && !isManageAllTarget(event.target)) {
		event.preventDefault();
		resumeSelectedDraft();
	}
}

watch(
	() => props.parkedOrders.length,
	() => {
		cardRefs.value = [];
		clampSelectedIndex();
	},
);

defineExpose({
	focusFirstDraft,
	focusSelectedDraft,
});
</script>

<style scoped>
.drafts-list {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.drafts-list__brand {
	display: flex;
	align-items: center;
	gap: 9px;
	min-height: 36px;
	padding: 0 2px 10px;
	border-bottom: 1px solid rgba(var(--v-theme-primary), 0.16);
	font-size: 0.86rem;
	font-weight: 750;
	letter-spacing: -0.01em;
	color: var(--pos-text-primary);
}

.drafts-list__brand-mark {
	display: block;
	width: 28px;
	height: 28px;
	object-fit: contain;
}

.drafts-list__header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
}

.drafts-list__eyebrow {
	margin: 0 0 2px;
	font-size: 0.72rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--pos-text-secondary);
}

.drafts-list__title {
	margin: 0;
	font-size: 1rem;
	font-weight: 700;
	color: var(--pos-text-primary);
}

.drafts-list__subtitle {
	margin: 4px 0 0;
	font-size: 0.82rem;
	color: var(--pos-text-secondary);
}

.drafts-list__actions {
	display: flex;
	align-items: center;
	gap: 8px;
}

.drafts-list__count {
	min-width: 28px;
	height: 28px;
	padding: 0 8px;
	border-radius: 999px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	background: rgba(var(--v-theme-primary), 0.14);
	color: rgb(var(--v-theme-primary));
	font-weight: 700;
}

.drafts-list__cards {
	display: flex;
	flex-direction: column;
	gap: 10px;
	max-height: calc(100vh - 180px);
	overflow: auto;
	padding-right: 2px;
}

.drafts-list__empty {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 6px;
	padding: 18px 16px;
	border-radius: 18px;
	border: 1px dashed rgba(var(--v-theme-primary), 0.24);
	background: rgba(var(--v-theme-surface), 0.72);
	color: var(--pos-text-secondary);
}

.drafts-list__empty--loading {
	flex-direction: row;
	align-items: center;
}

.drafts-list__empty strong {
	color: var(--pos-text-primary);
}

.drafts-list__card {
	position: relative;
	border: 1px solid rgba(var(--v-theme-primary), 0.14);
	border-radius: 16px;
	background: rgba(var(--v-theme-surface), 0.92);
	padding: 13px 14px;
	text-align: left;
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-width: 0;
	overflow: hidden;
	cursor: pointer;
	color: var(--pos-text-primary);
	transition:
		background-color 0.18s ease,
		box-shadow 0.18s ease,
		border-color 0.18s ease;
}

.drafts-list__card:hover,
.drafts-list__card:focus-visible {
	border-color: rgba(var(--v-theme-primary), 0.34);
}

.drafts-list__card--selected {
	border-color: rgba(var(--v-theme-primary), 0.62);
	background: rgba(var(--v-theme-primary), 0.1);
	box-shadow: 0 4px 12px rgba(15, 23, 42, 0.09);
}

.drafts-list__card--selected::before {
	position: absolute;
	inset-block: 9px;
	inset-inline-start: 0;
	width: 4px;
	border-radius: 0 4px 4px 0;
	background: rgb(var(--v-theme-primary));
	content: "";
}

.drafts-list__card:focus-visible {
	outline: none;
	box-shadow:
		inset 0 0 0 2px rgba(var(--v-theme-primary), 0.72),
		0 4px 12px rgba(15, 23, 42, 0.09);
}

.drafts-list__card-top {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: flex-start;
	gap: 12px;
	min-width: 0;
}

.drafts-list__card-top strong {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.drafts-list__amount {
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.drafts-list__meta {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 10px;
	font-size: 0.8rem;
	font-variant-numeric: tabular-nums;
	color: var(--pos-text-secondary);
}

@media (max-width: 420px) {
	.drafts-list__card {
		padding-inline: 12px;
	}

	.drafts-list__card-top {
		gap: 8px;
	}
}
</style>
