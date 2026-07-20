<template>
	<v-dialog
		:model-value="modelValue"
		max-width="720"
		persistent
		:retain-focus="true"
		@update:model-value="handleModelUpdate"
	>
		<v-card data-testid="manual-submission-recovery-dialog">
			<v-card-title>{{ __("Resolve uncertain document outcome") }}</v-card-title>
			<v-card-text class="manual-recovery-body">
				<v-alert type="warning" variant="tonal" density="compact">
					{{
						__(
							"Verify this document in the back office before choosing an outcome. The decision is audited and automatic replay remains disabled.",
						)
					}}
				</v-alert>

				<div class="manual-recovery-identity">
					<span>{{ __("Document Type") }}</span>
					<strong>{{ documentType }}</strong>
					<span>{{ __("Request ID") }}</span>
					<code>{{ requestId }}</code>
				</div>

				<v-radio-group
					v-model="outcome"
					:label="__('Verified outcome')"
					:disabled="loading"
					data-testid="manual-recovery-outcome"
				>
					<v-radio :value="'submitted'" :label="__('Created and submitted — clear this cart')" />
					<v-radio
						:value="'not_submitted'"
						:label="__('Not submitted — retain this cart for a controlled retry')"
					/>
				</v-radio-group>

				<v-text-field
					v-model="documentName"
					:label="
						outcome === 'submitted'
							? __('Submitted document name')
							: __('Document name checked (optional)')
					"
					:disabled="loading"
					data-testid="manual-recovery-document-name"
				/>
				<v-textarea
					v-model="note"
					:label="__('Supervisor verification note')"
					:disabled="loading"
					rows="3"
					data-testid="manual-recovery-note"
				/>
				<v-text-field
					v-model="confirmation"
					:label="__('Type the request ID to confirm')"
					:hint="requestId"
					persistent-hint
					:disabled="loading"
					data-testid="manual-recovery-confirmation"
				/>
			</v-card-text>
			<v-card-actions>
				<v-spacer />
				<v-btn
					variant="text"
					:disabled="loading"
					data-testid="manual-recovery-cancel"
					@click="cancel"
				>
					{{ __("Cancel") }}
				</v-btn>
				<v-btn
					color="warning"
					variant="flat"
					:loading="loading"
					:disabled="!canResolve"
					data-testid="manual-recovery-resolve"
					@click="resolve"
				>
					{{ __("Record decision and release lock") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
	modelValue: { type: Boolean, default: false },
	requestId: { type: String, default: "" },
	documentType: { type: String, default: "" },
	suggestedDocumentName: { type: String, default: "" },
	loading: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue", "resolve"]);
const __ = window.__ || ((value) => value);
const outcome = ref("");
const documentName = ref("");
const note = ref("");
const confirmation = ref("");

const canResolve = computed(
	() =>
		["submitted", "not_submitted"].includes(outcome.value) &&
		Boolean(note.value.trim()) &&
		confirmation.value.trim() === props.requestId.trim() &&
		(outcome.value !== "submitted" || Boolean(documentName.value.trim())) &&
		!props.loading,
);

const reset = () => {
	outcome.value = "";
	documentName.value = props.suggestedDocumentName || "";
	note.value = "";
	confirmation.value = "";
};

const cancel = () => {
	if (!props.loading) {
		emit("update:modelValue", false);
	}
};

const resolve = () => {
	if (!canResolve.value) return;
	emit("resolve", {
		outcome: outcome.value,
		documentName: documentName.value.trim(),
		note: note.value.trim(),
		confirmation: confirmation.value.trim(),
	});
};

const handleModelUpdate = (value) => {
	if (!value) cancel();
};

watch(
	() => props.modelValue,
	(open) => {
		if (open) reset();
	},
);
</script>

<style scoped>
.manual-recovery-body {
	display: grid;
	gap: 16px;
}

.manual-recovery-identity {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: 6px 12px;
	align-items: baseline;
}

.manual-recovery-identity span {
	color: var(--pos-text-secondary);
}

.manual-recovery-identity code {
	overflow-wrap: anywhere;
}
</style>
