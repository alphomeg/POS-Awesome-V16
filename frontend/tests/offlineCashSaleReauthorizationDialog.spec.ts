// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";

const {
	getInvoiceOutboxReauthorizationCommand,
	markInvoiceOutboxManualBackofficeReview,
	replaceInvoiceOutboxOfflineSaleAuthorization,
} = vi.hoisted(() => ({
	getInvoiceOutboxReauthorizationCommand: vi.fn(),
	markInvoiceOutboxManualBackofficeReview: vi.fn(),
	replaceInvoiceOutboxOfflineSaleAuthorization: vi.fn(),
}));
const { reauthorizeOfflineCashSaleAuthorization } = vi.hoisted(() => ({
	reauthorizeOfflineCashSaleAuthorization: vi.fn(),
}));

vi.mock("../src/offline", () => ({
	getInvoiceOutboxReauthorizationCommand,
	markInvoiceOutboxManualBackofficeReview,
	replaceInvoiceOutboxOfflineSaleAuthorization,
}));
vi.mock("../src/posapp/services/cashierSignatureService", () => ({
	reauthorizeOfflineCashSaleAuthorization,
}));

import OfflineCashSaleReauthorizationDialog from "../src/posapp/components/offline/OfflineCashSaleReauthorizationDialog.vue";

const BoxStub = defineComponent({
	props: { modelValue: { type: Boolean, default: true } },
	setup(props, { slots }) {
		return () =>
			props.modelValue ? h("div", slots.default?.()) : h("div");
	},
});

const VBtnStub = defineComponent({
	inheritAttrs: false,
	props: { disabled: { type: Boolean, default: false } },
	setup(props, { slots, attrs }) {
		return () =>
			h(
				"button",
				{
					type: "button",
					disabled: props.disabled,
					...attrs,
				},
				slots.default?.(),
			);
	},
});

const VTextFieldStub = defineComponent({
	props: {
		modelValue: { type: String, default: "" },
		disabled: { type: Boolean, default: false },
		errorMessages: { type: [String, Array], default: "" },
		label: { type: String, default: "" },
	},
	emits: ["update:modelValue", "keydown"],
	setup(props, { attrs, emit }) {
		return () =>
			h("input", {
				value: props.modelValue,
				type: "password",
				disabled: props.disabled,
				"data-testid": attrs["data-testid"],
				"aria-label": props.label,
				onInput: (event: Event) =>
					emit(
						"update:modelValue",
						(event.target as HTMLInputElement).value,
					),
				onKeydown: (event: KeyboardEvent) => emit("keydown", event),
			});
	},
});

const entry = {
	outbox_id: 7,
	client_request_id: "offline-request-1",
	status: "requires_reauthorization",
	offline_sale_authorization: null,
	invoice: {
		posa_client_request_id: "offline-request-1",
		company: "RetailMind",
	},
	data: { client_request_id: "offline-request-1" },
};
const command = {
	client_request_id: "offline-request-1",
	document_type: "Sales Invoice",
	invoice: entry.invoice,
	data: entry.data,
	offline_sale_authorization: "expired-ticket-secret",
};

const mountDialog = (props = {}) =>
	mount(OfflineCashSaleReauthorizationDialog, {
		props: {
			modelValue: true,
			posProfile: { name: "Main POS" },
			entry,
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
				VTextField: VTextFieldStub,
				VIcon: BoxStub,
				VSpacer: BoxStub,
			},
		},
	});

describe("OfflineCashSaleReauthorizationDialog", () => {
	beforeEach(() => {
		(window as any).__ = (value: string) => value;
		getInvoiceOutboxReauthorizationCommand.mockReset();
		markInvoiceOutboxManualBackofficeReview.mockReset();
		replaceInvoiceOutboxOfflineSaleAuthorization.mockReset();
		reauthorizeOfflineCashSaleAuthorization.mockReset();
		getInvoiceOutboxReauthorizationCommand.mockResolvedValue(command);
		markInvoiceOutboxManualBackofficeReview.mockResolvedValue(undefined);
		replaceInvoiceOutboxOfflineSaleAuthorization.mockResolvedValue(
			undefined,
		);
	});

	it("does not render the queued bearer and explains the immutable recovery boundary", () => {
		const wrapper = mountDialog();

		expect(wrapper.text()).toContain("Cashier reauthorization required");
		expect(wrapper.text()).toContain("offline-request-1");
		expect(wrapper.text()).toContain("never saved on this terminal");
		expect(wrapper.html()).not.toContain("expired-ticket-secret");
	});

	it("uses a transient PIN to replace only the queued sale's bearer, then requests sync", async () => {
		reauthorizeOfflineCashSaleAuthorization.mockResolvedValue({
			ticket: {
				authorization: "replacement-ticket-secret",
				client_request_id: "offline-request-1",
				owner_user: "cashier@example.com",
				document_type: "Sales Invoice",
			},
			approval_level: "requires_reauthorization",
		});
		const onReauthorized = vi.fn();
		const wrapper = mountDialog({ onReauthorized });

		await wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-pin"]')
			.setValue("2468");
		await wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-submit"]')
			.trigger("click");
		await flushPromises();
		await flushPromises();

		expect(reauthorizeOfflineCashSaleAuthorization).toHaveBeenCalledWith(
			"Main POS",
			"2468",
			expect.objectContaining({
				clientRequestId: "offline-request-1",
				documentType: "Sales Invoice",
				offlineSaleAuthorization: "expired-ticket-secret",
			}),
		);
		expect(getInvoiceOutboxReauthorizationCommand).toHaveBeenCalledWith(
			"offline-request-1",
			entry,
		);
		expect(
			replaceInvoiceOutboxOfflineSaleAuthorization,
		).toHaveBeenCalledWith(
			"offline-request-1",
			entry,
			"expired-ticket-secret",
			"replacement-ticket-secret",
			"cashier@example.com",
		);
		expect(onReauthorized).toHaveBeenCalledWith("offline-request-1");
		expect(
			(
				wrapper.get(
					'[data-testid="offline-cash-sale-reauthorization-pin"]',
				).element as HTMLInputElement
			).value,
		).toBe("");
	});

	it("uses supervisor-specific wording for a typed supervisor review state", () => {
		const wrapper = mountDialog({
			entry: { ...entry, status: "requires_supervisor_review" },
		});

		expect(wrapper.text()).toContain("Supervisor review required");
		expect(
			wrapper
				.get('[data-testid="offline-cash-sale-reauthorization-pin"]')
				.attributes("aria-label"),
		).toBe("Supervisor PIN");
	});

	it("shows durable back-office review without a PIN prompt when current policy rejects the command", () => {
		const wrapper = mountDialog({
			entry: {
				...entry,
				status: "requires_supervisor_review",
				recovery_action: "manual_backoffice_review",
			},
		});

		expect(wrapper.text()).toContain("Back-office review required");
		expect(wrapper.text()).toContain("Do not enter another PIN");
		expect(
			wrapper.find('[data-testid="offline-cash-sale-reauthorization-pin"]').exists(),
		).toBe(false);
		expect(
			wrapper.find('[data-testid="offline-cash-sale-reauthorization-submit"]').exists(),
		).toBe(false);
		expect(
			wrapper.find('[data-testid="offline-cash-sale-reauthorization-close"]').exists(),
		).toBe(true);
	});

	it("persists a legacy policy-impossible response as manual review instead of prompting for another PIN", async () => {
		const onManualReview = vi.fn();
		reauthorizeOfflineCashSaleAuthorization.mockRejectedValue(
			new Error(
				"The current POS Profile policy no longer permits automatic offline cash-sale reauthorization.",
			),
		);
		const wrapper = mountDialog({ onManualReview });

		await wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-pin"]')
			.setValue("2468");
		await wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-submit"]')
			.trigger("click");
		await flushPromises();
		await flushPromises();

		expect(markInvoiceOutboxManualBackofficeReview).toHaveBeenCalledWith(
			"offline-request-1",
			entry,
		);
		expect(onManualReview).toHaveBeenCalledWith("offline-request-1");
		expect(wrapper.text()).toContain("Back-office review required");
		expect(
			wrapper.find('[data-testid="offline-cash-sale-reauthorization-pin"]').exists(),
		).toBe(false);
	});

	it("uses an opaque protected handle without rendering another cashier's request identity", async () => {
		const privateEntry = {
			...entry,
			client_request_id: "private-request-id",
			invoice: { customer: "Sensitive Customer" },
			data: { secret: "Sensitive detail" },
		};
		const resolveProtectedEntry = vi.fn(() => privateEntry);
		const wrapper = mountDialog({
			entry: {
				status: "requires_reauthorization",
				protected_recovery: true,
				recovery_entry_id: "protected-1",
			},
			forceSupervisor: true,
			resolveProtectedEntry,
		});

		expect(wrapper.text()).toContain("Supervisor review required");
		expect(wrapper.text()).not.toContain("private-request-id");
		expect(wrapper.html()).not.toContain("Sensitive Customer");
		expect(wrapper.html()).not.toContain("Sensitive detail");

		await wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-pin"]')
			.setValue("2468");
		await wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-submit"]')
			.trigger("click");
		await flushPromises();
		await flushPromises();

		expect(resolveProtectedEntry).toHaveBeenCalledWith("protected-1");
		expect(getInvoiceOutboxReauthorizationCommand).toHaveBeenCalledWith(
			"private-request-id",
			privateEntry,
		);
	});
});
