<template>
	<v-dialog
		:model-value="modelValue"
		max-width="780"
		@update:model-value="emit('update:modelValue', $event)"
	>
		<v-card
			class="pos-maintenance-dialog pos-themed-card"
			data-test="pos-maintenance-dialog"
			role="dialog"
			aria-modal="true"
			:aria-labelledby="titleId"
		>
			<v-card-title :id="titleId" class="pos-maintenance-dialog__title">
				<span>
					<span class="mdi mdi-stethoscope" aria-hidden="true"></span>
					{{ __("Device & Submission Diagnostics") }}
				</span>
				<v-btn
					ref="closeButton"
					icon="mdi-close"
					variant="text"
					:aria-label="__('Close diagnostics')"
					data-test="pos-maintenance-close"
					@click="emit('update:modelValue', false)"
				/>
			</v-card-title>

			<v-card-text class="pos-maintenance-dialog__content">
				<div v-if="loading" class="pos-maintenance-dialog__loading" role="status">
					<v-progress-circular indeterminate size="24" />
					{{ __("Checking this device and the POS server...") }}
				</div>

				<template v-else>
					<section class="pos-maintenance-dialog__section">
						<h3>{{ __("Submission service") }}</h3>
						<div class="pos-maintenance-dialog__grid">
							<div>
								<span>{{ __("Mode") }}</span>
								<strong data-test="maintenance-submission-mode">
									{{ health?.submission_mode || __("Unavailable") }}
								</strong>
							</div>
							<div>
								<span>{{ __("Default workers") }}</span>
								<strong>{{ health?.queue?.workers?.default ?? "—" }}</strong>
							</div>
							<div>
								<span>{{ __("Queued jobs") }}</span>
								<strong>{{ health?.queue?.queue_depth?.default ?? "—" }}</strong>
							</div>
							<div>
								<span>{{ __("Active ledgers") }}</span>
								<strong>{{ health?.active_submission_count ?? "—" }}</strong>
							</div>
						</div>
						<p
							v-if="
								health?.background_submission_enabled &&
								!health?.queue?.default_worker_available
							"
							class="pos-maintenance-dialog__warning"
							data-test="maintenance-worker-warning"
						>
							{{
								__(
									"No default worker is online. New sales use synchronous submission so checkout remains available.",
								)
							}}
						</p>
					</section>

					<section class="pos-maintenance-dialog__section">
						<h3>{{ __("This browser") }}</h3>
						<div class="pos-maintenance-dialog__grid">
							<div>
								<span>{{ __("Invoice outbox") }}</span>
								<strong>{{ inventory?.operational?.invoiceOutbox ?? "—" }}</strong>
							</div>
							<div>
								<span>{{ __("Write queue") }}</span>
								<strong>{{ inventory?.operational?.writeQueue ?? "—" }}</strong>
							</div>
							<div>
								<span>{{ __("Intent journals") }}</span>
								<strong>{{ inventory?.operational?.intentJournals ?? "—" }}</strong>
							</div>
							<div>
								<span>{{ __("POS caches") }}</span>
								<strong>{{ inventory?.cacheNames?.length ?? "—" }}</strong>
							</div>
						</div>
					</section>

					<section
						v-if="health?.active_submissions?.length"
						class="pos-maintenance-dialog__section"
					>
						<h3>{{ __("Incomplete submissions") }}</h3>
						<div
							v-for="submission in health.active_submissions"
							:key="
								submission.client_request_id ||
								`${submission.state}-${submission.age_seconds}`
							"
							class="pos-maintenance-dialog__submission"
						>
							<div>
								<strong>{{ submission.state }}</strong>
								<span v-if="submission.invoice_name">
									{{ submission.invoice_name }}
								</span>
								<span>{{ formatAge(submission.age_seconds) }}</span>
							</div>
							<v-btn
								v-if="submission.client_request_id"
								size="small"
								variant="tonal"
								color="warning"
								data-test="maintenance-resume-submission"
								@click="emit('resume-submission', submission)"
							>
								{{ __("Resume same request") }}
							</v-btn>
						</div>
					</section>
				</template>
			</v-card-text>

			<v-card-actions class="pos-maintenance-dialog__actions">
				<v-btn
					variant="tonal"
					data-test="maintenance-refresh"
					@click="emit('refresh')"
				>
					{{ __("Refresh diagnostics") }}
				</v-btn>
				<v-btn
					variant="tonal"
					data-test="maintenance-repair-assets"
					@click="emit('repair-assets')"
				>
					{{ __("Repair App Assets") }}
				</v-btn>
				<v-btn
					v-if="health?.developer_reset_allowed"
					color="error"
					variant="tonal"
					data-test="maintenance-reset-local-pos"
					@click="emit('reset-local-pos')"
				>
					{{ __("Reset Local POS") }}
				</v-btn>
				<v-spacer />
				<v-btn
					color="primary"
					variant="flat"
					@click="emit('update:modelValue', false)"
				>
					{{ __("Done") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

defineOptions({ name: "PosMaintenanceDialog" });

const props = defineProps<{
	modelValue: boolean;
	loading?: boolean;
	health?: Record<string, any> | null;
	inventory?: Record<string, any> | null;
}>();

const emit = defineEmits<{
	(e: "update:modelValue", value: boolean): void;
	(e: "refresh"): void;
	(e: "repair-assets"): void;
	(e: "reset-local-pos"): void;
	(e: "resume-submission", submission: Record<string, any>): void;
}>();

// @ts-ignore
const __ = (window as any).__ || ((text: string) => text);
const titleId = "pos-maintenance-dialog-title";
const closeButton = ref<any>(null);

watch(
	() => props.modelValue,
	async (open) => {
		if (!open) return;
		await nextTick();
		closeButton.value?.$el?.focus?.();
	},
);

function formatAge(seconds: number | null | undefined) {
	if (seconds === null || seconds === undefined) return __("Age unavailable");
	if (seconds < 60) return __("{0}s old", [seconds]);
	if (seconds < 3600) return __("{0}m old", [Math.floor(seconds / 60)]);
	return __("{0}h old", [Math.floor(seconds / 3600)]);
}
</script>

<style scoped>
.pos-maintenance-dialog__title,
.pos-maintenance-dialog__actions,
.pos-maintenance-dialog__submission {
	display: flex;
	align-items: center;
	gap: 12px;
}

.pos-maintenance-dialog__title {
	justify-content: space-between;
}

.pos-maintenance-dialog__content,
.pos-maintenance-dialog__section,
.pos-maintenance-dialog__submission > div {
	display: grid;
	gap: 12px;
}

.pos-maintenance-dialog__grid {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 10px;
}

.pos-maintenance-dialog__grid > div {
	display: grid;
	gap: 4px;
	padding: 12px;
	border: 1px solid var(--pos-border);
	border-radius: 12px;
}

.pos-maintenance-dialog__grid span,
.pos-maintenance-dialog__submission span {
	color: var(--pos-text-secondary);
	font-size: 12px;
}

.pos-maintenance-dialog__warning {
	padding: 12px;
	border-radius: 10px;
	background: rgba(255, 152, 0, 0.12);
	color: var(--pos-text-primary);
}

.pos-maintenance-dialog__submission {
	justify-content: space-between;
	padding: 10px 12px;
	border: 1px solid var(--pos-border);
	border-radius: 12px;
}

.pos-maintenance-dialog__loading {
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 120px;
}

@media (max-width: 720px) {
	.pos-maintenance-dialog__grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}
</style>
