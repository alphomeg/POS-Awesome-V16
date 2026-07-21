// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, onMounted } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/offline/index", () => ({
	getOpeningDialogStorage: vi.fn(() => null),
	setOpeningDialogStorage: vi.fn(),
	setOpeningStorage: vi.fn(),
	getBootstrapSnapshot: vi.fn(() => null),
	setBootstrapSnapshot: vi.fn(),
	initPromise: Promise.resolve(),
	checkDbHealth: vi.fn(() => Promise.resolve()),
	isOfflineStorageReady: vi.fn(() => false),
}));

vi.mock("../src/offline/bootstrapSnapshot", () => ({
	createBootstrapSnapshotFromRegisterData: vi.fn(() => ({})),
}));

vi.mock("../src/posapp/services/authService", () => ({
	default: { logout: vi.fn(() => Promise.resolve()) },
}));

import OpeningDialog from "../src/posapp/components/pos/shift/OpeningDialog.vue";
import posSource from "../src/posapp/components/pos/shell/Pos.vue?raw";

const BoxStub = defineComponent({
	setup(_, { attrs, slots }) {
		return () => h("div", attrs, slots.default?.());
	},
});

const VDialogStub = defineComponent({
	props: { modelValue: Boolean },
	setup(props, { attrs, slots }) {
		onMounted(() =>
			nextTick(() =>
				(attrs.onAfterEnter as (() => void) | undefined)?.(),
			),
		);
		return () =>
			props.modelValue
				? h("div", { ...attrs, role: "dialog" }, slots.default?.())
				: null;
	},
});

const createInputStub = (name: string) =>
	defineComponent({
		name,
		props: {
			modelValue: { type: [String, Number], default: "" },
			type: { type: String, default: "text" },
		},
		emits: ["update:modelValue"],
		setup(props, { attrs, emit }) {
			return () =>
				h("div", attrs, [
					h("input", {
						type: props.type,
						value: props.modelValue,
						"aria-label": attrs["aria-label"],
						onInput: (event: Event) =>
							emit(
								"update:modelValue",
								(event.target as HTMLInputElement).value,
							),
					}),
				]);
		},
	});

const VBtnStub = defineComponent({
	props: { disabled: Boolean },
	setup(props, { attrs, slots }) {
		return () =>
			h(
				"button",
				{ ...attrs, type: "button", disabled: props.disabled },
				slots.default?.(),
			);
	},
});

const VDataTableStub = defineComponent({
	props: { items: { type: Array, default: () => [] } },
	setup(props, { attrs, slots }) {
		return () =>
			h(
				"div",
				attrs,
				(props.items as any[]).map((item) =>
					slots["item.amount"]?.({ item }),
				),
			);
	},
});

const mountDialog = () =>
	mount(OpeningDialog, {
		attachTo: document.body,
		props: { dialog: true },
		global: {
			components: {
				VDialog: VDialogStub,
				VCard: BoxStub,
				VCardTitle: BoxStub,
				VCardText: BoxStub,
				VCardActions: BoxStub,
				VContainer: BoxStub,
				VRow: BoxStub,
				VCol: BoxStub,
				VIcon: BoxStub,
				VSpacer: BoxStub,
				VAutocomplete: createInputStub("VAutocompleteStub"),
				VTextField: createInputStub("VTextFieldStub"),
				VDataTable: VDataTableStub,
				VBtn: VBtnStub,
			},
			config: {
				globalProperties: {
					frappe: (globalThis as any).frappe,
				},
			},
		},
	});

const keydown = (key: string, init: KeyboardEventInit = {}) =>
	new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});

describe("OpeningDialog keyboard accessibility", () => {
	beforeEach(() => {
		(globalThis as any).__ = (text: string, values: string[] = []) =>
			values.reduce(
				(result, value, index) => result.replace(`{${index}}`, value),
				text,
			);
		(globalThis as any).get_currency_symbol = () => "Rs ";
		(globalThis as any).frappe = {
			_: (text: string) => text,
			session: { user: "cashier@example.com" },
			call: vi.fn((request: any) => {
				if (typeof request === "object") {
					request.callback?.({
						message: {
							companies: [{ name: "Retail Co" }],
							pos_profiles_data: [
								{ name: "Main POS", company: "Retail Co" },
							],
							payments_method: [
								{
									parent: "Main POS",
									mode_of_payment: "Cash",
									currency: "PKR",
								},
								{
									parent: "Main POS",
									mode_of_payment: "Card",
									currency: "PKR",
								},
							],
						},
					});
				}
				return Promise.resolve({ message: null });
			}),
			set_route: vi.fn(),
		};
		vi.spyOn(
			HTMLElement.prototype,
			"getBoundingClientRect",
		).mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 120,
			bottom: 36,
			width: 120,
			height: 36,
			toJSON: () => ({}),
		} as DOMRect);
	});

	afterEach(() => {
		document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("names the dialog and moves initial focus to Company", async () => {
		const wrapper = mountDialog();
		await flushPromises();
		await nextTick();

		const dialog = wrapper.get('[role="dialog"]');
		expect(dialog.attributes("aria-labelledby")).toBe(
			"opening-shift-title",
		);
		expect(dialog.attributes("aria-describedby")).toContain(
			"opening-shift-description",
		);
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="opening-shift-company"] input').element,
		);
	});

	it("keeps native arrow behavior and advances opening amounts with Enter", async () => {
		const wrapper = mountDialog();
		await flushPromises();
		await nextTick();

		const company = wrapper.get(
			'[data-testid="opening-shift-company"] input',
		).element as HTMLInputElement;
		company.focus();
		const autocompleteArrow = keydown("ArrowDown");
		company.dispatchEvent(autocompleteArrow);
		expect(autocompleteArrow.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(company);

		const cash = wrapper.get('[data-opening-shift-amount="Cash"] input')
			.element as HTMLInputElement;
		const card = wrapper.get('[data-opening-shift-amount="Card"] input')
			.element as HTMLInputElement;
		const submit = wrapper.get('[data-testid="opening-shift-submit"]')
			.element as HTMLButtonElement;

		cash.focus();
		cash.dispatchEvent(keydown("Enter"));
		expect(document.activeElement).toBe(card);

		card.dispatchEvent(keydown("Enter"));
		expect(document.activeElement).toBe(submit);
	});

	it("delegates Tab and Shift+Tab trapping to the persistent Vuetify dialog", async () => {
		const wrapper = mountDialog();
		await flushPromises();
		await nextTick();

		const dialog = wrapper.get('[role="dialog"]');
		const company = wrapper.get(
			'[data-testid="opening-shift-company"] input',
		).element as HTMLInputElement;
		company.focus();
		const tab = keydown("Tab");
		company.dispatchEvent(tab);

		expect(dialog.attributes("retain-focus")).toBe("true");
		expect(tab.defaultPrevented).toBe(false);
	});

	it("exposes a logical focus order from profile setup through actions", async () => {
		const wrapper = mountDialog();
		await flushPromises();
		await nextTick();

		const targets = Array.from(
			wrapper.get('[data-testid="opening-shift-dialog"]').element.querySelectorAll(
				"[data-pos-keyboard-target]",
			),
		)
			.filter((element) => !element.hasAttribute("disabled"))
			.map((element) => element.getAttribute("data-pos-keyboard-target"));

		expect(targets).toEqual([
			"opening-shift-company",
			"opening-shift-pos-profile",
			"opening-shift-amount",
			"opening-shift-amount",
			"opening-shift-logout",
			"opening-shift-close",
			"opening-shift-submit",
		]);
		expect(wrapper.get('[data-opening-shift-amount="Cash"]').attributes("aria-label")).toBe(
			"Opening amount: Cash",
		);
	});

	it("guards shell Tab routing and restores the selling-surface focus contract", () => {
		expect(posSource).toContain(
			"event.defaultPrevented || checkoutMutationLocked.value || dialog.value",
		);
		expect(posSource).toContain(
			'event.target.closest(".v-overlay__content")',
		);
		expect(posSource).toContain(
			'this.eventBus?.emit?.("focus_invoice_item_entry")',
		);
	});
});
