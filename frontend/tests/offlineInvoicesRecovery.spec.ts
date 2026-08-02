// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { compileScript, parse } from "@vue/compiler-sfc";
import offlineInvoicesSource from "../src/posapp/components/OfflineInvoices.vue?raw";
import paymentsSource from "../src/posapp/components/pos/Payments.vue?raw";

const {
	deleteOfflineInvoice,
	getInvoiceOutboxRows,
	getOfflineInvoices,
	getPendingOfflineInvoiceCount,
	hasInvoiceOutboxOfflineSaleAuthorization,
	isInvoiceOutboxOwnedByScope,
	resolveInvoiceOutboxOwnerScope,
} = vi.hoisted(() => ({
	deleteOfflineInvoice: vi.fn(),
	getInvoiceOutboxRows: vi.fn(),
	getOfflineInvoices: vi.fn(),
	getPendingOfflineInvoiceCount: vi.fn(),
	hasInvoiceOutboxOfflineSaleAuthorization: vi.fn(),
	isInvoiceOutboxOwnedByScope: vi.fn(),
	resolveInvoiceOutboxOwnerScope: vi.fn(),
}));

vi.mock("../src/offline/index", () => ({
	deleteOfflineInvoice,
	getInvoiceOutboxRows,
	getOfflineInvoices,
	getPendingOfflineInvoiceCount,
	hasInvoiceOutboxOfflineSaleAuthorization,
	isInvoiceOutboxOwnedByScope,
	resolveInvoiceOutboxOwnerScope,
}));
vi.mock(
	"../src/posapp/components/offline/OfflineCashSaleReauthorizationDialog.vue",
	() => ({
		default: defineComponent({
			name: "OfflineCashSaleReauthorizationDialog",
			props: {
				entry: { type: Object, default: null },
				forceSupervisor: { type: Boolean, default: false },
			},
			template:
				'<div data-testid="offline-cash-sale-reauthorization-dialog">{{ JSON.stringify({ entry, forceSupervisor }) }}</div>',
		}),
	}),
);

import OfflineInvoices from "../src/posapp/components/OfflineInvoices.vue";

const BoxStub = defineComponent({
	props: { modelValue: { type: Boolean, default: true } },
	setup(props, { slots }) {
		return () =>
			props.modelValue ? h("div", slots.default?.()) : h("div");
	},
});

const VDataTableStub = defineComponent({
	props: { items: { type: Array, default: () => [] } },
	setup(props, { slots }) {
		return () =>
			h(
				"div",
				{ "data-testid": "offline-data-table" },
				props.items.map((item: any) =>
					h("section", { "data-testid": "offline-data-table-row" }, [
						h("pre", JSON.stringify(item)),
						slots["item.customer"]?.({ item }),
						slots["item.posting_date"]?.({ item }),
						slots["item.grand_total"]?.({ item }),
						slots["item.status"]?.({ item }),
						slots["item.actions"]?.({ item }),
					]),
				),
			);
	},
});

const VBtnStub = defineComponent({
	inheritAttrs: false,
	setup(_props, { attrs, slots }) {
		return () => h("button", attrs, slots.default?.());
	},
});

const mountDialog = (props = {}) =>
	mount(OfflineInvoices, {
	props: {
		modelValue: false,
		posProfile: { name: "Main POS", company: "Test Company" },
			...props,
		},
		global: {
			components: {
				VRow: BoxStub,
				VDialog: BoxStub,
				VCard: BoxStub,
				VCardTitle: BoxStub,
				VCardText: BoxStub,
				VCardActions: BoxStub,
				VContainer: BoxStub,
				VDivider: BoxStub,
				VIcon: BoxStub,
				VChip: BoxStub,
				VBtn: VBtnStub,
				VTooltip: BoxStub,
				VAlert: BoxStub,
				VAvatar: BoxStub,
				VDataTable: VDataTableStub,
			},
		},
	});

describe("OfflineInvoices recovery rows", () => {
	beforeEach(() => {
		(window as any).__ = (value: string) => value;
		(window as any).get_currency_symbol = () => "Rs";
		deleteOfflineInvoice.mockReset();
		getInvoiceOutboxRows.mockReset();
		getOfflineInvoices.mockReset();
		getPendingOfflineInvoiceCount.mockReset();
		hasInvoiceOutboxOfflineSaleAuthorization.mockReset();
		isInvoiceOutboxOwnedByScope.mockReset();
		resolveInvoiceOutboxOwnerScope.mockReset();
		resolveInvoiceOutboxOwnerScope.mockImplementation((scope: any) => ({
			owner_user: "cashier-a@example.com",
			pos_profile: scope.pos_profile || "Main POS",
			company: scope.company || "Test Company",
		}));
		isInvoiceOutboxOwnedByScope.mockImplementation((entry: any, scope: any) =>
			entry?.owner_user === scope?.owner_user &&
			entry?.pos_profile === scope?.pos_profile &&
			entry?.company === scope?.company,
		);
		hasInvoiceOutboxOfflineSaleAuthorization.mockImplementation(
			(entry: any) => entry?.has_offline_sale_authorization === true,
		);
		getOfflineInvoices.mockReturnValue([]);
		getInvoiceOutboxRows.mockResolvedValue([
			{
				outbox_id: 7,
				client_request_id: "offline-request-1",
				owner_user: "cashier-a@example.com",
				pos_profile: "Main POS",
				company: "Test Company",
				status: "requires_reauthorization",
				offline_sale_authorization: null,
				has_offline_sale_authorization: true,
				invoice: {
					posa_client_request_id: "offline-request-1",
					customer: "Walk-in Customer",
				},
				data: { client_request_id: "offline-request-1" },
			},
		]);
	});

	it("keeps a durable recovery row visible without retaining its bearer in dialog state", async () => {
		const wrapper = mountDialog();

		await wrapper.setProps({ modelValue: true });
		await flushPromises();
		await flushPromises();

		const renderedRows = wrapper
			.get('[data-testid="offline-data-table"]')
			.text();
		expect(renderedRows).toContain("offline-request-1");
		expect(renderedRows).toContain("invoice_outbox");
		expect(renderedRows).toContain("requires_reauthorization");
		expect(renderedRows).toContain('"offline_sale_authorization":null');
		expect(renderedRows).toContain('"has_offline_sale_authorization":true');
		expect(renderedRows).not.toContain("expired-ticket-secret");
		expect(getInvoiceOutboxRows).toHaveBeenCalledWith({
			redactOfflineSaleAuthorization: true,
		});
	});

	it("counts all unresolved signed rows, including pending, retrying, and waiting-owner work", async () => {
		getInvoiceOutboxRows.mockResolvedValue([
			"pending",
			"retrying",
			"waiting_owner",
		].map((status, index) => ({
			outbox_id: index + 1,
			client_request_id: `signed-${status}-request`,
			owner_user: "cashier-a@example.com",
			pos_profile: "Main POS",
			company: "Test Company",
			status,
			offline_sale_authorization: null,
			has_offline_sale_authorization: true,
			invoice: {
				customer: `Customer ${index + 1}`,
				grand_total: index + 1,
			},
			data: {},
		})));
		const wrapper = mountDialog();

		await wrapper.setProps({ modelValue: true });
		await flushPromises();
		await flushPromises();

		const renderedRows = wrapper.get('[data-testid="offline-data-table"]').text();
		expect(renderedRows).toContain("signed-pending-request");
		expect(renderedRows).toContain("signed-retrying-request");
		expect(renderedRows).toContain("signed-waiting_owner-request");
		expect(wrapper.text()).toContain("3 Pending Sync");
		expect(wrapper.text()).not.toContain("All Synchronized");
	});

	it("redacts another cashier's signed sale while offering only supervisor recovery", async () => {
		getInvoiceOutboxRows.mockResolvedValue([
			{
				outbox_id: 9,
				client_request_id: "private-request-id",
				owner_user: "cashier-b@example.com",
				pos_profile: "Main POS",
				company: "Test Company",
				status: "requires_reauthorization",
				offline_sale_authorization: null,
				has_offline_sale_authorization: true,
				invoice: {
					customer: "Sensitive Patient Name",
					customer_name: "Sensitive Patient Name",
					posting_date: "2026-08-02",
					grand_total: 98765,
					currency: "PKR",
				},
				data: { private_note: "Sensitive payment detail" },
			},
		]);
		const wrapper = mountDialog();

		await wrapper.setProps({ modelValue: true });
		await flushPromises();
		await flushPromises();

		const renderedRows = wrapper.get('[data-testid="offline-data-table"]').text();
		for (const privateValue of [
			"Sensitive Patient Name",
			"98765",
			"Sensitive payment detail",
			"private-request-id",
		]) {
			expect(renderedRows).not.toContain(privateValue);
		}
		expect(wrapper.text()).toContain("Protected queued sale");
		expect(wrapper.text()).toContain("Supervisor Reauthorize");

		const recoveryButton = wrapper
			.findAll("button")
			.find((button) => button.text().includes("Supervisor Reauthorize"));
		expect(recoveryButton).toBeTruthy();
		await recoveryButton?.trigger("click");
		await flushPromises();
		const dialogProjection = wrapper
			.get('[data-testid="offline-cash-sale-reauthorization-dialog"]')
			.text();
		for (const privateValue of [
			"Sensitive Patient Name",
			"98765",
			"Sensitive payment detail",
			"private-request-id",
		]) {
			expect(dialogProjection).not.toContain(privateValue);
		}
		expect(dialogProjection).toContain('"forceSupervisor":true');
	});

	it("shows a signed dead letter as back-office review without a PIN recovery action", async () => {
		getInvoiceOutboxRows.mockResolvedValue([
			{
				outbox_id: 10,
				client_request_id: "signed-dead-letter-request",
				owner_user: "cashier-a@example.com",
				pos_profile: "Main POS",
				company: "Test Company",
				status: "dead_letter",
				offline_sale_authorization: null,
				has_offline_sale_authorization: true,
				invoice: { customer: "Own Customer", grand_total: 1 },
				data: {},
			},
		]);
		const wrapper = mountDialog();

		await wrapper.setProps({ modelValue: true });
		await flushPromises();
		await flushPromises();

		expect(wrapper.text()).toContain("Back-office review required");
		expect(wrapper.text()).not.toContain("Reauthorize");
	});

	it("keeps protected rows and cashier ticket bearers outside compiled script-setup state", () => {
		const compile = (source: string, filename: string) => {
			const { descriptor, errors } = parse(source, { filename });
			expect(errors).toEqual([]);
			return compileScript(descriptor, { id: filename }).content;
		};
		const offlineInvoicesSetup = compile(
			offlineInvoicesSource,
			"OfflineInvoices.vue",
		);
		const paymentsSetup = compile(paymentsSource, "Payments.vue");

		expect(offlineInvoicesSetup).not.toContain("protectedRecoveryEntries");
		expect(offlineInvoicesSetup).not.toContain(
			"selectedProtectedRecoveryResolver",
		);
		expect(paymentsSetup).not.toContain(
			"let cashierSigningOfflineAuthorization =",
		);
	});
});
