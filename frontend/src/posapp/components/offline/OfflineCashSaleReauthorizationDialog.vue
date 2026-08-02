<template>
	<v-dialog
		:model-value="modelValue"
		persistent
		max-width="560px"
		@update:model-value="handleModelUpdate"
		@after-enter="focusPinInput"
	>
		<v-card class="offline-cash-sale-reauthorization" data-testid="offline-cash-sale-reauthorization">
			<v-card-title class="offline-cash-sale-reauthorization__title">
				<v-icon
					:icon="requiresManualBackofficeReview || requiresSupervisor ? 'mdi-shield-account-outline' : 'mdi-key-outline'"
					class="mr-3"
					aria-hidden="true"
				/>
				{{ title }}
			</v-card-title>

			<v-card-text class="offline-cash-sale-reauthorization__body">
				<p>{{ description }}</p>
				<p v-if="!isProtectedRecovery" class="offline-cash-sale-reauthorization__request-id">
					<strong>{{ __("Request ID") }}:</strong> {{ clientRequestId }}
				</p>
				<p v-if="requiresManualBackofficeReview" class="offline-cash-sale-reauthorization__notice">
					{{ __("The protected queued sale remains retained on this terminal for supervisor review.") }}
				</p>
				<p v-else class="offline-cash-sale-reauthorization__notice">
					{{
						__(
							"The queued sale is unchanged. Your PIN is checked online and is never saved on this terminal.",
						)
					}}
				</p>

				<v-text-field
					v-if="!requiresManualBackofficeReview"
					ref="pinInput"
					v-model="cashierPin"
					:label="requiresSupervisor ? __('Supervisor PIN') : __('Cashier PIN')"
					type="password"
					inputmode="numeric"
					autocomplete="off"
					variant="outlined"
					density="comfortable"
					:disabled="loading"
					:error-messages="errorMessage"
					data-testid="offline-cash-sale-reauthorization-pin"
					@keydown.enter.prevent="submit"
				/>
			</v-card-text>

			<v-card-actions class="offline-cash-sale-reauthorization__actions">
				<v-btn
					v-if="requiresManualBackofficeReview"
					variant="text"
					data-testid="offline-cash-sale-reauthorization-close"
					@click="close"
				>
					{{ __("Close") }}
				</v-btn>
				<v-btn
					v-else
					variant="text"
					:disabled="loading"
					data-testid="offline-cash-sale-reauthorization-cancel"
					@click="close"
				>
					{{ __("Cancel") }}
				</v-btn>
				<v-spacer />
				<v-btn
					v-if="!requiresManualBackofficeReview"
					color="primary"
					variant="flat"
					:loading="loading"
					:disabled="!canSubmit"
					data-testid="offline-cash-sale-reauthorization-submit"
					@click="submit"
				>
					{{ requiresSupervisor ? __("Supervisor Reauthorize") : __("Reauthorize Sale") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import {
	getInvoiceOutboxReauthorizationCommand,
	markInvoiceOutboxManualBackofficeReview,
	replaceInvoiceOutboxOfflineSaleAuthorization,
} from "../../../offline";
import { reauthorizeOfflineCashSaleAuthorization } from "../../services/cashierSignatureService";

const props = defineProps({
	modelValue: { type: Boolean, default: false },
	posProfile: { type: Object, default: () => ({}) },
	entry: { type: Object, default: null },
	forceSupervisor: { type: Boolean, default: false },
	resolveProtectedEntry: { type: Function, default: null },
});

const emit = defineEmits(["update:modelValue", "reauthorized", "manual-review"]);
const __ = window.__ || ((value: string) => value);

const cashierPin = ref("");
const errorMessage = ref("");
const loading = ref(false);
const pinInput = ref<any>(null);
const manualBackofficeResolution = ref(false);

const clientRequestId = computed(() => String(props.entry?.client_request_id || "").trim());
const isProtectedRecovery = computed(() => Boolean(props.entry?.protected_recovery));
const requiresManualBackofficeReview = computed(
	() =>
		manualBackofficeResolution.value ||
		props.entry?.recovery_action === "manual_backoffice_review",
);
const requiresSupervisor = computed(
	() =>
		!requiresManualBackofficeReview.value &&
		(props.forceSupervisor || props.entry?.status === "requires_supervisor_review"),
);
const title = computed(() =>
	requiresManualBackofficeReview.value
		? __("Back-office review required")
		: requiresSupervisor.value
			? __("Supervisor review required")
			: __("Cashier reauthorization required"),
);
const description = computed(() =>
	requiresManualBackofficeReview.value
		? __(
				"Current POS policy cannot authorize this queued sale. Do not enter another PIN; a supervisor must verify it in the back office.",
			)
		: requiresSupervisor.value
		? __("A POS supervisor must reauthorize this queued offline cash sale before it can sync.")
		: __(
				"This offline cash-sale authorization expired before the sale could sync. Enter the same cashier's PIN to reauthorize this exact queued sale.",
			),
);
const canSubmit = computed(
	() =>
		!loading.value &&
		!requiresManualBackofficeReview.value &&
		Boolean(String(props.posProfile?.name || "").trim()) &&
		Boolean(
			isProtectedRecovery.value
				? props.entry?.recovery_entry_id
				: clientRequestId.value,
		) &&
		Boolean(cashierPin.value.trim()),
);

function resetTransientState() {
	cashierPin.value = "";
	errorMessage.value = "";
	manualBackofficeResolution.value = false;
}

function focusPinInput() {
	const input = pinInput.value?.$el?.querySelector?.("input");
	input?.focus?.();
}

function close() {
	if (loading.value) return;
	resetTransientState();
	emit("update:modelValue", false);
}

function handleModelUpdate(value: boolean) {
	if (!value) close();
}

/** Never render raw transport errors, which may contain server diagnostics. */
function safeErrorMessage(error: unknown) {
	const message = String((error as any)?.message || "").toLowerCase();
	if (message.includes("invalid cashier pin")) {
		return __("Invalid PIN. Try again.");
	}
	if (message.includes("supervisor")) {
		return __("A POS supervisor must reauthorize this queued sale.");
	}
	if (message.includes("connection") || message.includes("network") || message.includes("timeout")) {
		return __("Reauthorization needs a live connection. Check it and try again.");
	}
	return __("The queued sale could not be reauthorized. Check the PIN and try again.");
}

function isManualBackofficeResolution(error: unknown) {
	const candidate = error as any;
	const reason = String(
		candidate?.reason || candidate?.response?.reason || candidate?.data?.reason || "",
	).trim();
	if (["manual_backoffice_review", "current_policy_rejects_command"].includes(reason)) {
		return true;
	}
	// Older servers return the same safe policy outcome only in the Frappe
	// message. Keep that compatibility path narrow and never render it.
	const message = String(candidate?.message || candidate || "").toLowerCase();
	return (
		message.includes("current_policy_rejects_command") ||
		message.includes("no longer permits automatic offline cash-sale reauthorization") ||
		message.includes("current pos policy cannot authorize this queued sale") ||
		message.includes("current policy rejects this queued offline cash sale")
	);
}

function resolveEntryForAttempt() {
	if (!isProtectedRecovery.value) return props.entry;
	const entry = props.resolveProtectedEntry?.(props.entry?.recovery_entry_id);
	if (!entry) {
		throw new Error(
			"The protected queued sale changed. Reload the offline invoices list before recovery.",
		);
	}
	return entry;
}

async function submit() {
	if (!canSubmit.value || !props.entry) return;

	errorMessage.value = "";
	loading.value = true;
	const pin = cashierPin.value.trim();
	// PIN values never survive in reactive component state while IndexedDB is
	// consulted or the online request is in flight.
	cashierPin.value = "";
	let recoveryEntry: any = null;
	let recoveryRequestId = "";
	try {
		recoveryEntry = resolveEntryForAttempt();
		recoveryRequestId = String(recoveryEntry?.client_request_id || "").trim();
		if (!recoveryRequestId) {
			throw new Error("Offline cash-sale reauthorization requires a client request ID");
		}
		// The outbox verifies this display-safe row before returning the exact
		// current command. Keep that credential-bearing command only in this
		// local variable while the online request and compare-and-set run.
		const command = await getInvoiceOutboxReauthorizationCommand(
			recoveryRequestId,
			recoveryEntry,
		);
		const reauthorization = reauthorizeOfflineCashSaleAuthorization(
			String(props.posProfile?.name || "").trim(),
			pin,
			{
				clientRequestId: command.client_request_id,
				documentType: command.document_type,
				invoice: command.invoice,
				data: command.data,
				offlineSaleAuthorization: command.offline_sale_authorization,
			},
		);
		const response = await reauthorization;
		await replaceInvoiceOutboxOfflineSaleAuthorization(
			recoveryRequestId,
			recoveryEntry,
			command.offline_sale_authorization,
			response.ticket.authorization,
			response.ticket.owner_user,
		);
		emit("reauthorized", recoveryRequestId);
		emit("update:modelValue", false);
	} catch (error) {
		cashierPin.value = "";
		if (isManualBackofficeResolution(error)) {
			if (recoveryEntry && recoveryRequestId) {
				try {
					await markInvoiceOutboxManualBackofficeReview(
						recoveryRequestId,
						recoveryEntry,
					);
					emit("manual-review", recoveryRequestId);
				} catch {
					// The current dialog still stops PIN retries. A later reload may
					// retry the guarded metadata write without exposing diagnostics.
				}
			}
			manualBackofficeResolution.value = true;
			errorMessage.value = "";
		} else {
			errorMessage.value = safeErrorMessage(error);
		}
		await nextTick();
		if (!manualBackofficeResolution.value) focusPinInput();
	} finally {
		loading.value = false;
	}
}

watch(
	() => props.modelValue,
	(isOpen) => {
		if (!isOpen) {
			resetTransientState();
			return;
		}
		nextTick(focusPinInput);
	},
);
watch(
	() => props.entry,
	() => {
		if (!loading.value) resetTransientState();
	},
);
</script>

<style scoped>
.offline-cash-sale-reauthorization__title {
	align-items: center;
	font-weight: 700;
}

.offline-cash-sale-reauthorization__body {
	color: #23313a;
}

.offline-cash-sale-reauthorization__request-id {
	overflow-wrap: anywhere;
	padding: 10px 12px;
	border-radius: 6px;
	background: #f1f5f7;
	font-family: monospace;
}

.offline-cash-sale-reauthorization__notice {
	margin-bottom: 18px;
	color: #38505b;
	font-size: 0.9rem;
}

.offline-cash-sale-reauthorization__actions {
	padding: 16px 24px;
}
</style>
