<template>
	<v-card flat :class="['cards mb-0 mt-3 pa-0', { compact }]">
		<v-row align="start" no-gutters>
			<v-col cols="12" sm="6">
				<v-btn
					ref="submitButton"
					block
					size="large"
					color="primary"
					variant="flat"
					class="payment-submit-btn payment-footer-btn"
					data-pos-keyboard-target="payment-submit"
					data-testid="payment-submit"
					@click="$emit('submit')"
					:loading="loading"
					:disabled="loading || validatePayment || locked"
					:class="{ 'submit-highlight': highlightSubmit }"
				>
					{{ __("Submit") }}
				</v-btn>
			</v-col>
			<v-col cols="12" sm="6" class="payment-action-col">
				<v-btn
					block
					size="large"
					color="success"
					variant="flat"
					class="payment-submit-print-btn payment-footer-btn"
					data-pos-keyboard-target="payment-submit-print"
					data-testid="payment-submit-print"
					@click="$emit('submit-and-print')"
					:loading="loading"
					:disabled="loading || validatePayment || locked"
				>
					{{ __("Submit & Print") }}
				</v-btn>
			</v-col>
			<v-col cols="12">
				<v-btn
					block
					size="large"
					color="error"
					variant="flat"
					class="mt-2 pa-1 payment-cancel-btn payment-footer-btn"
					data-pos-keyboard-target="payment-cancel"
					data-testid="payment-cancel"
					@click="$emit('cancel')"
					:disabled="locked"
				>
					{{ __("Cancel Payment") }}
				</v-btn>
			</v-col>
		</v-row>
	</v-card>
</template>

<script setup>
defineProps({
	loading: Boolean,
	validatePayment: Boolean,
	highlightSubmit: Boolean,
	compact: Boolean,
	locked: Boolean,
});

defineEmits(["submit", "submit-and-print", "cancel"]);

const __ = window.__;
</script>

<style scoped>
.cards {
	background: transparent !important;
}

.compact :deep(.v-btn),
:deep(.compact .v-btn) {
	min-height: 42px;
}

.payment-footer-btn {
	--v-theme-overlay-multiplier: 0 !important;
	transition:
		box-shadow 0.18s ease,
		background-color 0.18s ease,
		transform 0.18s ease !important;
	color: #ffffff !important;
	min-height: 48px !important;
}

.payment-submit-btn {
	background-color: #0b5cab !important;
}

.payment-submit-print-btn {
	background-color: #047857 !important;
}

.payment-cancel-btn {
	background-color: #b91c1c !important;
}

.payment-footer-btn:hover,
.payment-footer-btn:focus,
.payment-footer-btn:focus-visible,
.payment-footer-btn:active {
	box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18) !important;
	transform: translateY(-1px);
}

.payment-submit-btn:hover,
.payment-submit-btn:focus,
.payment-submit-btn:focus-visible,
.payment-submit-btn:active {
	background-color: #084d96 !important;
}

.payment-submit-print-btn:hover,
.payment-submit-print-btn:focus,
.payment-submit-print-btn:focus-visible,
.payment-submit-print-btn:active {
	background-color: #065f46 !important;
}

.payment-cancel-btn:hover,
.payment-cancel-btn:focus,
.payment-cancel-btn:focus-visible,
.payment-cancel-btn:active {
	background-color: #991b1b !important;
}

.payment-action-col {
	padding-left: 4px;
}

.payment-footer-btn:active {
	transform: translateY(0);
}

:deep(.payment-footer-btn .v-btn__overlay),
:deep(.payment-footer-btn .v-btn__underlay) {
	opacity: 0 !important;
	background: transparent !important;
}

:deep(.payment-footer-btn .v-btn__content) {
	color: #ffffff !important;
}

@media (max-width: 768px) {
	.cards {
		margin-top: 0 !important;
	}

	.payment-action-col {
		padding-left: 0;
		padding-top: 6px;
	}

	.payment-footer-btn {
		font-size: 0.82rem !important;
	}

	:deep(.payment-footer-btn.v-btn) {
		min-height: 38px !important;
	}

	:deep(.payment-footer-btn .v-btn__content) {
		font-size: 0.82rem !important;
		line-height: 1.15;
	}
}

@media (max-width: 480px) {
	.payment-footer-btn {
		font-size: 0.76rem !important;
	}

	:deep(.payment-footer-btn.v-btn) {
		min-height: 34px !important;
	}

	:deep(.payment-footer-btn .v-btn__content) {
		font-size: 0.76rem !important;
	}
}
</style>
