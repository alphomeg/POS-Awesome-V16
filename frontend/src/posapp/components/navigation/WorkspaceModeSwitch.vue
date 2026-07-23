<template>
	<div v-if="visible" class="workspace-mode-bar">
		<nav class="workspace-mode-switch" :aria-label="__('POS workspace')">
			<v-btn
				:variant="sellingActive ? 'flat' : 'text'"
				:color="sellingActive ? 'primary' : undefined"
				prepend-icon="mdi-network-pos"
				class="workspace-mode-switch__button"
				:aria-current="sellingActive ? 'page' : undefined"
				data-pos-keyboard-target
				@click="router.push('/pos')"
			>
				{{ __("Selling") }}
			</v-btn>
			<v-btn
				:variant="purchasingActive ? 'flat' : 'text'"
				:color="purchasingActive ? 'primary' : undefined"
				prepend-icon="mdi-cart-arrow-down"
				class="workspace-mode-switch__button"
				:aria-current="purchasingActive ? 'page' : undefined"
				data-pos-keyboard-target
				@click="router.push('/orders')"
			>
				{{ __("Purchasing") }}
			</v-btn>
		</nav>
		<span class="workspace-mode-bar__context">
			{{ purchasingActive ? __("Purchase orders and receiving") : __("Sales, orders, and quotations") }}
		</span>
	</div>
</template>

<script setup>
import { computed, getCurrentInstance } from "vue";
import { useRoute, useRouter } from "vue-router";

const instance = getCurrentInstance();
const __ = instance?.proxy?.__ || ((value) => value);
const route = useRoute();
const router = useRouter();

const sellingActive = computed(() => route.path === "/pos");
const purchasingActive = computed(() => route.path === "/orders");
const visible = computed(() => sellingActive.value || purchasingActive.value);
</script>

<style scoped>
.workspace-mode-bar {
	display: flex;
	flex: 0 0 auto;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	min-height: 46px;
	padding: 5px 18px;
	border-bottom: 1px solid var(--pos-border);
	background: var(--pos-surface-raised);
	box-shadow: 0 2px 8px rgba(15, 76, 66, 0.08);
}

.workspace-mode-switch {
	display: inline-flex;
	gap: 4px;
	padding: 2px;
	border: 1px solid var(--pos-border-light);
	border-radius: 7px;
	background: var(--pos-surface-variant);
}

.workspace-mode-switch__button {
	min-width: 132px;
	min-height: 34px !important;
	border-radius: 5px !important;
	text-transform: none !important;
	font-weight: 700;
	letter-spacing: 0 !important;
}

.workspace-mode-bar__context {
	font-size: 0.78rem;
	color: var(--pos-text-muted);
}

@media (max-width: 720px) {
	.workspace-mode-bar {
		padding-inline: 8px;
	}

	.workspace-mode-switch {
		flex: 1 1 auto;
	}

	.workspace-mode-switch__button {
		flex: 1 1 50%;
		min-width: 0;
	}

	.workspace-mode-bar__context {
		display: none;
	}
}
</style>
