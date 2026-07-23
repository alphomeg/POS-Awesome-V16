// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

import CashierSaleSigningDialog from "../src/posapp/components/pos/payments/CashierSaleSigningDialog.vue";

const BoxStub = defineComponent({
	props: {
		modelValue: { type: Boolean, default: true },
	},
	setup(props, { slots }) {
		return () => (props.modelValue ? h("div", slots.default?.()) : h("div"));
	},
});

const VIconStub = defineComponent({
	setup() {
		return () => h("span", { "aria-hidden": "true" });
	},
});

const VBtnStub = defineComponent({
	inheritAttrs: false,
	setup(_, { slots, attrs }) {
		return () =>
			h(
				"button",
				{
					type: "button",
					...attrs,
				},
				slots.default?.(),
			);
	},
});

const VTextFieldStub = defineComponent({
	props: {
		modelValue: { type: [String, Number], default: "" },
		disabled: { type: Boolean, default: false },
	},
	emits: ["update:modelValue", "keydown"],
	setup(props, { emit, attrs }) {
		return () =>
			h("input", {
				value: props.modelValue,
				disabled: props.disabled,
				"data-testid": attrs["data-testid"],
				onInput: (event: Event) =>
					emit("update:modelValue", (event.target as HTMLInputElement).value),
				onKeydown: (event: KeyboardEvent) => emit("keydown", event),
			});
	},
});

const mountDialog = (props = {}) =>
	mount(CashierSaleSigningDialog, {
		props: {
			modelValue: true,
			amount: 1000,
			currency: "Rs",
			customerName: "Ayesha Khan",
			creditEligible: true,
			creditContext: {
				current_outstanding: 2000,
				configured_limit: 5000,
			},
			payments: [
				{ mode_of_payment: "Cash", type: "Cash", default: 1 },
				{ mode_of_payment: "Credit Card", type: "Bank" },
			],
			formatCurrency: (value: number) => `Rs${Number(value).toFixed(2)}`,
			...props,
		},
		global: {
			components: {
				VDialog: BoxStub,
				VCard: BoxStub,
				VCardTitle: BoxStub,
				VCardText: BoxStub,
				VCardActions: BoxStub,
				VBtn: VBtnStub,
				VIcon: VIconStub,
				VTextField: VTextFieldStub,
			},
		},
	});

describe("CashierSaleSigningDialog", () => {
	beforeEach(() => {
		(window as any).__ = (value: string) => value;
	});

	it("shows RetailMind branding and defaults to pay in full", () => {
		const wrapper = mountDialog();

		expect(wrapper.text()).toContain("RetailMind-POS");
		expect(wrapper.text()).toContain("Ayesha Khan");
		expect(wrapper.get('[data-testid="cashier-sale-pay-in-full"]').attributes("aria-checked")).toBe(
			"true",
		);
		expect(wrapper.findAll('[data-testid="cashier-sale-payment-method"]')).toHaveLength(2);
	});

	it("keeps credit unavailable for the walk-in customer", async () => {
		const wrapper = mountDialog({
			customerName: "Walk-in Customer",
			creditEligible: false,
			creditReason: "WALK_IN_CUSTOMER",
		});

		const creditButton = wrapper.get('[data-testid="cashier-sale-credit"]');
		expect(creditButton.attributes()).toHaveProperty("disabled");
		expect(wrapper.text()).toContain("Select a named customer");
	});

	it("submits a full-credit sale without requiring a payment method", async () => {
		const onSubmit = vi.fn();
		const wrapper = mountDialog({ onSubmit });

		await wrapper.get('[data-testid="cashier-sale-credit"]').trigger("click");
		await wrapper.get('[data-testid="cashier-sale-pin-input"]').setValue("2468");
		(wrapper.vm as any).submit();

		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
			cashierPin: "2468",
			settlementMode: "credit",
			receivedAmount: 0,
			dueDate: "",
		}));
	});

	it("submits a part-paid credit sale with the selected tender", async () => {
		const onSubmit = vi.fn();
		const wrapper = mountDialog({ onSubmit });

		await wrapper.get('[data-testid="cashier-sale-credit"]').trigger("click");
		await wrapper.get('[data-testid="cashier-sale-received-amount"]').setValue("250");
		await wrapper.findAll('[data-testid="cashier-sale-payment-method"]')[1].trigger("click");
		await wrapper.get('[data-testid="cashier-sale-pin-input"]').setValue("1357");
		(wrapper.vm as any).submit();

		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
			cashierPin: "1357",
			modeOfPayment: "Credit Card",
			settlementMode: "credit",
			receivedAmount: 250,
		}));
	});
});
