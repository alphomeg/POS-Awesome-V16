// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { beforeEach, describe, expect, it } from "vitest";

import PaymentActionButtons from "../src/posapp/components/pos/payments/PaymentActionButtons.vue";
import manualRecoveryDialogSource from "../src/posapp/components/pos/payments/ManualSubmissionRecoveryDialog.vue?raw";
import invoiceSource from "../src/posapp/components/pos/Invoice.vue?raw";
import invoiceActionsSource from "../src/posapp/components/pos/invoice_utils/actions.ts?raw";
import paymentsSource from "../src/posapp/components/pos/Payments.vue?raw";
import posShellSource from "../src/posapp/components/pos/shell/Pos.vue?raw";
import uiStoreSource from "../src/posapp/stores/uiStore.ts?raw";
import itemAdditionSource from "../src/posapp/composables/pos/items/useItemAddition.ts?raw";

const BoxStub = defineComponent({
	setup(_, { slots }) {
		return () => h("div", {}, slots.default?.());
	},
});

const ButtonStub = defineComponent({
	inheritAttrs: false,
	props: {
		disabled: Boolean,
		loading: Boolean,
	},
	emits: ["click"],
	setup(props, { attrs, emit, slots }) {
		return () =>
			h(
				"button",
				{
					...attrs,
					disabled: props.disabled || props.loading,
					onClick: () => emit("click"),
				},
				slots.default?.(),
			);
	},
});

describe("ambiguous payment submission recovery UX", () => {
	beforeEach(() => {
		(window as any).__ = (value: string) => value;
	});

	it("disables submit, print, and cancel while confirmation owns the tender", () => {
		const wrapper = mount(PaymentActionButtons, {
			props: {
				loading: false,
				validatePayment: false,
				locked: true,
			},
			global: {
				components: {
					VCard: BoxStub,
					VRow: BoxStub,
					VCol: BoxStub,
					VBtn: ButtonStub,
				},
			},
		});

		for (const testId of [
			"payment-submit",
			"payment-submit-print",
			"payment-cancel",
		]) {
			expect(
				(
					wrapper.get(`[data-testid="${testId}"]`)
						.element as HTMLButtonElement
				).disabled,
			).toBe(true);
		}
	});

	it("keeps a persistent do-not-retry banner and supervisor-only status action", () => {
		expect(paymentsSource).toContain(
			"Sale received; confirming status — do not retry",
		);
		expect(paymentsSource).toContain(
			'data-testid="submission-recovery-banner"',
		);
		expect(paymentsSource).toContain(
			'data-testid="submission-recovery-status-check"',
		);
		expect(paymentsSource).toContain(
			"Boolean(currentCashier?.is_supervisor)",
		);
		expect(paymentsSource).toContain("submissionRecoveryCanCheckStatus");
		expect(paymentsSource).toContain(':locked="checkoutMutationLocked"');
		expect(paymentsSource).toContain(
			':inert="checkoutMutationLocked || undefined"',
		);
		expect(paymentsSource).toContain(
			"checkoutMutationLocked.value && !force",
		);
		expect(paymentsSource).toMatch(
			/eventBus\.on\("clear_invoice"[\s\S]{0,120}checkoutMutationLocked\.value[\s\S]{0,60}return/,
		);
	});

	it("leaves reconnect ownership to the layout and keeps mount recovery silent", () => {
		expect(paymentsSource).toContain(
			"syncStore.syncPendingInvoices({ showToasts: false })",
		);
		expect(paymentsSource).not.toContain(
			'eventBus.on("network-online", () => syncStore.syncPendingInvoices())',
		);
		expect(paymentsSource).not.toContain(
			'eventBus.on("server-online", () => syncStore.syncPendingInvoices())',
		);
		expect(paymentsSource).not.toContain('eventBus.off("network-online")');
		expect(paymentsSource).not.toContain('eventBus.off("server-online")');
	});

	it("keeps the payment dialog mounted when Escape or its scrim requests close", () => {
		expect(paymentsSource).toContain(
			'emit("submission-recovery-lock-change", Boolean(locked))',
		);
		expect(posShellSource).toContain(
			':persistent="checkoutMutationLocked"',
		);
		expect(posShellSource).toContain(
			'@submission-recovery-lock-change="handlePaymentSubmissionRecoveryLockChange"',
		);
		expect(posShellSource).toMatch(
			/handlePaymentDialogUpdate = \(value\)[\s\S]{0,350}checkoutMutationLocked\.value[\s\S]{0,180}uiStore\.openPaymentDialog\(\)/,
		);
		expect(posShellSource).not.toContain('v-model="paymentDialogOpen"');
	});

	it("hydrates ownerless durable recovery into a visible dialog without replacing live owners", () => {
		expect(posShellSource).toMatch(
			/Boolean\(\s*getActiveInvoiceSubmissionRecovery\(\),?\s*\)/,
		);
		expect(posShellSource).toContain(
			"shouldUsePaymentDialog({",
		);
		expect(posShellSource).toContain(
			'uiStore.setCheckoutPaymentHostOwner("dialog")',
		);
		expect(posShellSource).toContain('host-owner="inline"');
		expect(posShellSource).toContain('host-owner="dialog"');
		expect(posShellSource).toContain('host-owner="shortcut"');
		expect(posShellSource).toContain(
			"'payment-shortcut-host--locked':",
		);
		expect(posShellSource).toMatch(
			/\.payment-shortcut-host--locked\s*\{[\s\S]{0,120}display:\s*block/,
		);
		expect(
			posShellSource.match(
				/@submission-recovery-lock-change="handlePaymentSubmissionRecoveryLockChange"/g,
			),
		).toHaveLength(3);
	});

	it("freezes live mobile and shortcut host ownership while blocking cart mutations", () => {
		expect(paymentsSource).toMatch(
			/checkoutMutationLocked = computed\([\s\S]{0,220}submissionInFlight\.value[\s\S]{0,180}submissionRecoveryLocked\.value/,
		);
		expect(paymentsSource).toContain(
			"uiStore.setCheckoutSubmissionInFlight?.(true)",
		);
		expect(paymentsSource).toMatch(
			/setCheckoutPaymentHostOwner\?\.\(props\.hostOwner\)[\s\S]{0,180}setCheckoutSubmissionInFlight\?\.\(true\)/,
		);
		expect(paymentsSource).toContain(
			"uiStore.setCheckoutSubmissionInFlight?.(false)",
		);
		expect(posShellSource).toContain(
			"ensureLockedPaymentHostVisible()",
		);
		expect(posShellSource).not.toMatch(
			/watch\(\s*checkoutMutationLocked[\s\S]{0,260}closePaymentShortcutHost\(\)/,
		);
		expect(posShellSource).toContain(
			':inert="checkoutMutationLocked || undefined"',
		);
		expect(posShellSource).not.toMatch(
			/<v-row[\s\S]{0,120}:inert="checkoutMutationLocked \|\| undefined"/,
		);
		expect(posShellSource).toMatch(
			/<Payments[\s\S]{0,100}host-owner="inline"[\s\S]{0,160}submission-recovery-lock-change/,
		);
		expect(paymentsSource).toMatch(
			/<div[\s\S]{0,180}submission-recovery-banner[\s\S]{0,1200}<v-card[\s\S]{0,100}:inert="checkoutMutationLocked \|\| undefined"/,
		);
		expect(posShellSource).toMatch(
			/setSelectorView = \(view\)[\s\S]{0,100}checkoutMutationLocked\.value[\s\S]{0,40}return/,
		);
		expect(posShellSource).toMatch(
			/handleCounterItemAdded = \([\s\S]{0,120}checkoutMutationLocked\.value[\s\S]{0,40}return/,
		);
		expect(posShellSource).toMatch(
			/handleAdditionalDiscountUpdate = \(value\)[\s\S]{0,100}checkoutMutationLocked\.value[\s\S]{0,40}return/,
		);
		expect(invoiceActionsSource).toMatch(
			/export function clear_invoice[\s\S]{0,140}checkoutMutationIsLocked\(context\)[\s\S]{0,30}return/,
		);
		expect(invoiceSource).toMatch(
			/created\(\)[\s\S]{0,100}!this\.uiStore\.checkoutMutationLocked[\s\S]{0,80}invoiceStore\.clear\(\)/,
		);
		expect(itemAdditionSource).toMatch(
			/async function addItemMeasured[\s\S]{0,140}checkoutMutationLocked[\s\S]{0,30}return/,
		);
	});

	it("keeps payment hosts mounted but hides every payment surface while cashier signing is open", () => {
		expect(uiStoreSource).toContain("const cashierSigningOpen = ref(false)");
		expect(uiStoreSource).toContain("const setCashierSigningOpen = (open: boolean)");
		expect(posShellSource).toMatch(
			/return\s*\{[\s\S]{0,1400}cashierSigningOpen/,
		);
		expect(posShellSource).toContain(
			":class=\"{ 'payment-dialog--cashier-signing': cashierSigningOpen }\"",
		);
		expect(posShellSource).toContain('v-show="!cashierSigningOpen"');
		expect(posShellSource).toMatch(
			/:deep\(\.payment-dialog--cashier-signing\)\s*\{[\s\S]{0,80}display:\s*none\s*!important/,
		);
		expect(posShellSource).toMatch(
			/'payment-shortcut-host--locked':[\s\S]{0,180}!cashierSigningOpen/,
		);
		expect(paymentsSource).toMatch(
			/requestCashierSigning = \(\)[\s\S]{0,900}setCashierSigningOpen\?\.\(true\)/,
		);
		expect(paymentsSource).toMatch(
			/settleCashierSigning = \(result\)[\s\S]{0,220}setCashierSigningOpen\?\.\(false\)/,
		);
	});

	it("offers supervisors an audited two-outcome release for non-invoice recovery", () => {
		expect(paymentsSource).toContain(
			"submissionRecoveryCanResolveManually",
		);
		expect(paymentsSource).toContain('data-testid="manual-recovery-open"');
		expect(paymentsSource).toMatch(
			/submissionRecoveryCanResolveManually[\s\S]{0,120}Boolean\(currentCashier\?\.is_supervisor\)/,
		);
		expect(manualRecoveryDialogSource).toContain(
			"Created and submitted — clear this cart",
		);
		expect(manualRecoveryDialogSource).toContain(
			"Not submitted — retain this cart for a controlled retry",
		);
		expect(manualRecoveryDialogSource).toContain(
			"confirmation.value.trim() === props.requestId.trim()",
		);
		expect(manualRecoveryDialogSource).toContain(
			"The decision is audited and automatic replay remains disabled.",
		);
	});
});
