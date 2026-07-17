// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

vi.mock("../src/posapp/components/pos/customer/Customer.vue", () => ({
	default: defineComponent({
		name: "Customer",
		setup() {
			return () => h("div", { "data-testid": "customer-control" });
		},
	}),
}));

const IconStub = defineComponent({
	name: "VIcon",
	props: ["icon"],
	setup(props) {
		return () => h("span", { "data-icon": props.icon });
	},
});

const SelectStub = defineComponent({
	name: "VSelect",
	props: ["modelValue", "label", "items"],
	emits: ["update:modelValue", "update:model-value"],
	setup(props, { emit }) {
		return () =>
			h(
				"button",
				{
					"data-select-label": props.label,
					onClick: () => emit("update:modelValue", "Updated"),
				},
				String(props.modelValue || ""),
			);
	},
});

const DatePickerStub = defineComponent({
	name: "VueDatePicker",
	props: ["modelValue"],
	emits: ["update:modelValue", "update:model-value"],
	setup(props, { emit }) {
		return () =>
			h(
				"button",
				{
					"data-testid": "posting-date-picker",
					onClick: () => emit("update:modelValue", "18-07-2026"),
				},
				String(props.modelValue || ""),
			);
	},
});

const mountHeader = async (posProfile: Record<string, unknown>) => {
	const { default: CounterGridTransactionHeader } = await import(
		"../src/posapp/components/pos/invoice/CounterGridTransactionHeader.vue"
	);
	return mount(CounterGridTransactionHeader, {
		props: {
			posProfile,
			invoiceTypes: ["Invoice", "Order"],
			invoiceType: "Invoice",
			postingDateDisplay: "17-07-2026",
			customerBalance: 10,
			customerBalanceCurrency: "PKR",
			priceList: "Standard Selling",
			priceLists: ["Standard Selling"],
			netTotal: 125.5,
			displayCurrency: "PKR",
			formatCurrency: (value: number | undefined, currency?: string | number) =>
				`${typeof currency === "string" ? "Rs" : ""}${Number(value || 0).toFixed(2)}`,
			currencySymbol: () => "Rs",
		},
		global: {
			components: {
				VIcon: IconStub,
				VSelect: SelectStub,
				VueDatePicker: DatePickerStub,
				VChip: defineComponent({
					setup(_, { slots }) {
						return () => h("span", {}, slots.default?.());
					},
				}),
				VSkeletonLoader: true,
			},
		},
	});
};

describe("CounterGridTransactionHeader", () => {
	beforeEach(() => {
		vi.stubGlobal("__", (value: string) => value);
		window.__ = (value: string) => value;
	});

	it("renders the target context order and formats the existing subtotal as Net Total", async () => {
		const wrapper = await mountHeader({
			posa_allow_sales_order: 1,
			posa_allow_change_posting_date: 1,
			posa_show_customer_balance: 1,
			create_pos_invoice_instead_of_sales_invoice: 1,
		});

		expect(wrapper.get(".counter-grid-context-card--customer").exists()).toBe(true);
		expect(wrapper.get(".counter-grid-context-card--type").exists()).toBe(true);
		expect(wrapper.get(".counter-grid-context-card--date").exists()).toBe(true);
		expect(wrapper.get(".counter-grid-context-card--balance").text()).toContain("Rs10.00");
		expect(wrapper.get('[data-testid="counter-grid-net-total"]').text()).toContain("Rs125.50");
		expect(wrapper.get(".counter-grid-context-card--type").attributes("title")).toContain(
			"POS Invoices",
		);
	});

	it("keeps Type and Date visible but read-only when the profile disallows editing", async () => {
		const wrapper = await mountHeader({
			posa_allow_sales_order: 0,
			posa_allow_change_posting_date: 0,
			posa_show_customer_balance: 0,
		});

		expect(wrapper.get(".counter-grid-context-card--type").text()).toContain("Invoice");
		expect(wrapper.get(".counter-grid-context-card--date").text()).toContain("17-07-2026");
		expect(wrapper.find('[data-testid="posting-date-picker"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="counter-grid-customer-balance"]').exists()).toBe(false);
		expect(wrapper.classes()).toContain("counter-grid-transaction-header--no-balance");
	});

	it("renders editable type, posting-date, and price-list controls when enabled", async () => {
		const wrapper = await mountHeader({
			posa_allow_sales_order: 1,
			posa_allow_change_posting_date: 1,
			posa_enable_price_list_dropdown: 1,
		});

		const selects = wrapper.findAllComponents(SelectStub);
		expect(selects).toHaveLength(2);
		expect(wrapper.findComponent(DatePickerStub).exists()).toBe(true);
		expect(wrapper.classes()).toContain("counter-grid-transaction-header--with-extras");
	});
});
