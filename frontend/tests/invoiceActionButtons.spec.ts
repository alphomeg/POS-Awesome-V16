// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

const setRect = (element: HTMLElement, left: number, top: number) => {
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: left,
		y: top,
		left,
		top,
		right: left + 100,
		bottom: top + 40,
		width: 100,
		height: 40,
		toJSON: () => ({}),
	} as DOMRect);
};

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("InvoiceActionButtons", () => {
	it("does not render share last invoice in the invoice summary actions", async () => {
		vi.stubGlobal("__", (value: string) => value);
		const { default: InvoiceActionButtons } = await import(
			"../src/posapp/components/pos/invoice/InvoiceActionButtons.vue"
		);

		const wrapper = mount(InvoiceActionButtons, {
			props: {
				pos_profile: {
					custom_allow_select_sales_order: 0,
					posa_allow_return: 1,
					posa_allow_print_draft_invoices: 1,
				},
			},
			global: {
				stubs: {
					VRow: { template: "<div><slot /></div>" },
					VCol: { template: "<div><slot /></div>" },
					VBtn: {
						props: ["prependIcon"],
						template: "<button><slot /></button>",
					},
				},
			},
		});

		expect(wrapper.text()).not.toContain("Share Last Invoice");
		expect((InvoiceActionButtons as any).emits).not.toContain("share-last");
	});

	it("keeps primary and profile-enabled actions reachable in Counter Grid", async () => {
		vi.stubGlobal("__", (value: string) => value);
		const { default: InvoiceActionButtons } = await import(
			"../src/posapp/components/pos/invoice/InvoiceActionButtons.vue"
		);

		const wrapper = mount(InvoiceActionButtons, {
			props: {
				presentation: "counter-grid",
				pos_profile: {
					custom_allow_select_sales_order: 1,
					posa_allow_return: 1,
					posa_allow_print_draft_invoices: 1,
					posa_enable_customer_display: 1,
				},
			},
			global: {
				components: {
					VBtn: {
						template: '<button v-bind="$attrs"><slot /></button>',
					},
					VMenu: {
						template:
							'<div><slot name="activator" :props="{}" /><slot /></div>',
					},
					VList: { template: "<div><slot /></div>" },
					VListItem: {
						emits: ["click"],
						template:
							'<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
					},
					VListItemTitle: { template: "<span><slot /></span>" },
				},
			},
		});

		const setupState = (wrapper.vm as any).$?.setupState || {};
		expect(
			setupState.isCounterGrid?.value ?? setupState.isCounterGrid,
		).toBe(true);
		expect(
			setupState.showMoreActions?.value ?? setupState.showMoreActions,
		).toBe(true);
		expect(
			wrapper.get('[data-testid="counter-grid-actions"]').exists(),
		).toBe(true);
		expect(wrapper.get('[data-testid="counter-grid-actions"]').classes()).toContain(
			"counter-grid-actions--with-return",
		);
		expect(
			wrapper.get('[data-testid="invoice-action-offers"]').text(),
		).toContain("Offers");
		expect(
			wrapper.get('[data-testid="invoice-action-coupons"]').text(),
		).toContain("Coupons");

		expect((InvoiceActionButtons as any).emits).toEqual(
			expect.arrayContaining(["open-offers", "open-coupons"]),
		);
	});

	it("supports arrow traversal across Counter Grid actions and returns upward from the first action", async () => {
		vi.stubGlobal("__", (value: string) => value);
		const { default: InvoiceActionButtons } = await import(
			"../src/posapp/components/pos/invoice/InvoiceActionButtons.vue"
		);
		const onNavigateBack = vi.fn();
		const wrapper = mount(InvoiceActionButtons, {
			attachTo: document.body,
			props: {
				presentation: "counter-grid",
				pos_profile: {
					posa_allow_return: 1,
				},
				onNavigateBack,
			},
			global: {
				components: {
					VBtn: {
						inheritAttrs: false,
						template: '<button v-bind="$attrs" :disabled="$attrs.loading"><slot /></button>',
					},
					VMenu: {
						template: '<div><slot name="activator" :props="{}" /></div>',
					},
				},
			},
		});

		const actionIds = [
			"invoice-action-save-clear",
			"invoice-action-drafts",
			"invoice-action-management",
			"invoice-action-returns",
			"invoice-action-more",
			"invoice-action-cancel-sale",
			"invoice-action-pay",
		];
		for (const [index, testId] of actionIds.entries()) {
			setRect(wrapper.get(`[data-testid="${testId}"]`).element as HTMLElement, index * 110, 0);
		}
		const actions = wrapper.get('[data-testid="counter-grid-actions"]');

		await (wrapper.vm as any).focusFirstAction();
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-save-clear"]').element,
		);
		await (wrapper.vm as any).focusPayAction();
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-pay"]').element,
		);
		await (wrapper.vm as any).focusFirstAction();

		await actions.trigger("keydown", {
			key: "ArrowRight",
		});
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-drafts"]').element,
		);
		await actions.trigger("keydown", {
			key: "ArrowUp",
		});
		expect(onNavigateBack).not.toHaveBeenCalled();

		await actions.trigger("keydown", {
			key: "ArrowLeft",
		});
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-save-clear"]').element,
		);

		await actions.trigger("keydown", {
			key: "ArrowUp",
		});
		expect(onNavigateBack).toHaveBeenCalledTimes(1);

		await (wrapper.vm as any).focusFirstAction();
		await actions.trigger("keydown", {
			key: "ArrowRight",
			shiftKey: true,
		});
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-save-clear"]').element,
		);
	});

	it("starts at the first enabled visible action and skips unavailable variants", async () => {
		vi.stubGlobal("__", (value: string) => value);
		const { default: InvoiceActionButtons } = await import(
			"../src/posapp/components/pos/invoice/InvoiceActionButtons.vue"
		);
		const onNavigateBack = vi.fn();
		const wrapper = mount(InvoiceActionButtons, {
			attachTo: document.body,
			props: {
				presentation: "counter-grid",
				pos_profile: { posa_allow_return: 0 },
				saveLoading: true,
				onNavigateBack,
			},
			global: {
				components: {
					VBtn: {
						inheritAttrs: false,
						template: '<button v-bind="$attrs" :disabled="$attrs.loading"><slot /></button>',
					},
					VMenu: {
						template: '<div><slot name="activator" :props="{}" /></div>',
					},
				},
			},
		});

		const ids = [
			"invoice-action-drafts",
			"invoice-action-management",
			"invoice-action-more",
			"invoice-action-cancel-sale",
			"invoice-action-pay",
		];
		for (const [index, testId] of ids.entries()) {
			setRect(wrapper.get(`[data-testid="${testId}"]`).element as HTMLElement, index * 110, 0);
		}
		expect(wrapper.find('[data-testid="invoice-action-returns"]').exists()).toBe(false);

		await (wrapper.vm as any).focusFirstAction();
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-drafts"]').element,
		);

		const actions = wrapper.get('[data-testid="counter-grid-actions"]');
		await actions.trigger("keydown", { key: "ArrowUp" });
		expect(onNavigateBack).toHaveBeenCalledTimes(1);
		await actions.trigger("keydown", { key: "ArrowLeft" });
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="invoice-action-drafts"]').element,
		);
	});
});
