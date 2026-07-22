<template>
	<v-dialog
		:model-value="modelValue"
		max-width="520"
		persistent
		@update:model-value="handleModelUpdate"
		@after-enter="focusPin"
		@after-leave="restoreTriggerFocus"
	>
		<v-card
			ref="dialogRoot"
			class="purchase-authorization pos-themed-card"
			data-pos-keyboard-root
			@keydown.capture="handleKeydown"
		>
			<v-card-title class="purchase-authorization__header">
				<div>
					<div class="text-overline">{{ __("Authorized checkpoint") }}</div>
					<div class="text-h6">{{ title }}</div>
				</div>
				<v-btn
					icon="mdi-close"
					variant="text"
					:disabled="loading"
					:aria-label="__('Cancel authorization')"
					@click="cancel"
				/>
			</v-card-title>

			<v-card-text class="purchase-authorization__body">
				<div class="purchase-authorization__document">
					<v-icon icon="mdi-file-document-check-outline" color="primary" />
					<div>
						<strong>{{ documentName }}</strong>
						<span>{{ description }}</span>
					</div>
				</div>
				<v-alert type="info" variant="tonal" density="compact" class="mb-3">
					{{ __("Required role: {0}", [requiredRole]) }}
				</v-alert>
				<v-text-field
					ref="pinInput"
					v-model="pin"
					type="password"
					inputmode="numeric"
					autocomplete="off"
					:label="__('Authorizer PIN')"
					variant="outlined"
					density="comfortable"
					:disabled="loading"
					:error-messages="errorMessage"
					@keydown.enter.prevent="submit"
				/>
			</v-card-text>

			<v-card-actions class="purchase-authorization__actions">
				<v-btn variant="text" :disabled="loading" @click="cancel">
					{{ __("Cancel") }}
				</v-btn>
				<v-spacer />
				<v-btn
					color="primary"
					variant="flat"
					prepend-icon="mdi-shield-check-outline"
					:loading="loading"
					:disabled="!pin.trim() || loading"
					@click="submit"
				>
					{{ confirmLabel }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup>
import { nextTick, ref, watch } from "vue";
import { moveFocusByArrow } from "../../../utils/keyboardNavigation";

const props = defineProps({
	modelValue: Boolean,
	title: { type: String, default: "" },
	description: { type: String, default: "" },
	documentName: { type: String, default: "" },
	requiredRole: { type: String, default: "" },
	confirmLabel: { type: String, default: "" },
	loading: Boolean,
	error: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "submit", "cancel"]);
const __ = window.__ || ((text) => text);
const pin = ref("");
const pinInput = ref(null);
const dialogRoot = ref(null);
const errorMessage = ref("");
const triggerElement = ref(null);
const restoreFocusOnLeave = ref(false);

watch(
	() => props.modelValue,
	(value) => {
		if (value) {
			triggerElement.value = document.activeElement;
			restoreFocusOnLeave.value = false;
			pin.value = "";
			errorMessage.value = props.error || "";
		}
	},
);

watch(
	() => props.error,
	(value) => {
		errorMessage.value = value || "";
		if (value) {
			pin.value = "";
			nextTick(focusPin);
		}
	},
);

function focusPin() {
	pinInput.value?.$el?.querySelector?.("input")?.focus?.();
}

function handleModelUpdate(value) {
	if (!value && !props.loading) cancel();
}

function cancel() {
	if (props.loading) return;
	restoreFocusOnLeave.value = true;
	emit("cancel");
	emit("update:modelValue", false);
}

function restoreTriggerFocus() {
	if (restoreFocusOnLeave.value && triggerElement.value?.isConnected) {
		triggerElement.value.focus?.();
	}
	restoreFocusOnLeave.value = false;
	triggerElement.value = null;
}

function submit() {
	const authorizationPin = pin.value.trim();
	if (!authorizationPin) {
		errorMessage.value = __("Authorization PIN is required.");
		return;
	}
	emit("submit", { authorizationPin });
}

function handleKeydown(event) {
	if (event.key === "Escape" && !props.loading) {
		event.preventDefault();
		cancel();
		return;
	}
	moveFocusByArrow(event, { root: dialogRoot.value?.$el || dialogRoot.value });
}
</script>

<style scoped>
.purchase-authorization__header,
.purchase-authorization__actions {
	display: flex;
	align-items: center;
	padding: 12px 16px;
}

.purchase-authorization__header {
	justify-content: space-between;
	border-bottom: 1px solid var(--pos-border);
}

.purchase-authorization__body {
	padding: 16px;
}

.purchase-authorization__document {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 12px;
	margin-bottom: 12px;
	border: 1px solid var(--pos-border-light);
	border-radius: 8px;
	background: var(--pos-surface-variant);
}

.purchase-authorization__document div {
	display: grid;
	gap: 2px;
}

.purchase-authorization__document span {
	font-size: 0.82rem;
	color: var(--pos-text-muted);
}
</style>
