// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

const offlineState = vi.hoisted(() => ({
	offline: false,
	cache: new Map<string, any[]>(),
	setCalls: [] as Array<{ profileName: string; data: any[] }>,
}));

vi.mock("../src/offline/index", () => ({
	isOffline: () => offlineState.offline,
	getSalesPersonsStorage: (profileName?: string) =>
		offlineState.cache.get(String(profileName || "")) || [],
	setSalesPersonsStorage: (profileName: string, data: any[]) => {
		offlineState.cache.set(profileName, data);
		offlineState.setCalls.push({ profileName, data });
	},
	flushPersistQueue: () => Promise.resolve(),
	getCachedCustomerAddresses: () => [],
	saveCustomerAddressesCache: vi.fn(),
}));

describe("profile-scoped sales-person options", () => {
	beforeEach(() => {
		vi.resetModules();
		offlineState.offline = false;
		offlineState.cache.clear();
		offlineState.setCalls = [];
		(window as any).__ = (value: string) => value;
		(window as any).frappe = {
			call: vi.fn(),
			datetime: {
				nowdate: () => "2026-08-01",
				obj_to_str: (value: any) => value,
			},
		};
	});

	it("uses only the active profile cache and does not call the server while offline", async () => {
		offlineState.offline = true;
		offlineState.cache.set("POS-A", [
			{
				name: "SP-A",
				sales_person_name: "Sales Person A",
				value: "SP-A",
				title: "Sales Person A",
			},
		]);
		offlineState.cache.set("POS-B", [
			{
				name: "SP-B",
				sales_person_name: "Sales Person B",
				value: "SP-B",
				title: "Sales Person B",
			},
		]);

		const { useInvoiceDetails } = await import(
			"../src/posapp/composables/pos/invoice/useInvoiceDetails"
		);
		const invoiceDetails = useInvoiceDetails({
			invoiceDoc: ref({}),
			posProfile: ref({ name: "POS-A", posa_local_storage: 1 }),
			invoiceType: ref("Invoice"),
		});

		await invoiceDetails.get_sales_person_names();

		expect(invoiceDetails.sales_persons.value).toEqual([
			expect.objectContaining({ name: "SP-A", title: "Sales Person A" }),
		]);
		expect((window as any).frappe.call).not.toHaveBeenCalled();
	});

	it("uses profile-defined options as a safe offline fallback", async () => {
		offlineState.offline = true;
		const { useInvoiceDetails } = await import(
			"../src/posapp/composables/pos/invoice/useInvoiceDetails"
		);
		const invoiceDetails = useInvoiceDetails({
			invoiceDoc: ref({}),
			posProfile: ref({
				name: "POS-A",
				posa_local_storage: 1,
				posa_sales_persons: [{ sales_person: "SP-CONFIGURED" }],
			}),
			invoiceType: ref("Invoice"),
		});

		await invoiceDetails.get_sales_person_names();

		expect(invoiceDetails.sales_persons.value).toEqual([
			expect.objectContaining({ name: "SP-CONFIGURED", title: "SP-CONFIGURED" }),
		]);
		expect((window as any).frappe.call).not.toHaveBeenCalled();
	});

	it("refreshes and durably caches sales people under the current profile scope online", async () => {
		(window as any).frappe.call = vi.fn(({ callback }: any) => {
			callback({
				message: [
					{ name: "SP-A", sales_person_name: "Sales Person A" },
				],
			});
		});
		const { loadSalesPersonOptions } = await import(
			"../src/posapp/services/salesPersonService"
		);

		const options = await loadSalesPersonOptions(
			{ name: "POS-A", posa_local_storage: 1 },
			{ refresh: true },
		);

		expect(options).toEqual([
			expect.objectContaining({ name: "SP-A", title: "Sales Person A" }),
		]);
		expect((window as any).frappe.call).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "posawesome.posawesome.api.utilities.get_sales_person_names",
				args: { pos_profile: "POS-A" },
			}),
		);
		expect(offlineState.setCalls).toEqual([
			expect.objectContaining({
				profileName: "POS-A",
				data: [expect.objectContaining({ name: "SP-A" })],
			}),
		]);
	});

	it("keeps a durable scoped cache when an online refresh fails", async () => {
		offlineState.cache.set("POS-A", [
			{
				name: "SP-A",
				sales_person_name: "Sales Person A",
				value: "SP-A",
				title: "Sales Person A",
			},
		]);
		(window as any).frappe.call = vi.fn(({ error }: any) => error(new Error("offline")));
		const { loadSalesPersonOptions } = await import(
			"../src/posapp/services/salesPersonService"
		);

		const options = await loadSalesPersonOptions(
			{ name: "POS-A", posa_local_storage: 1 },
			{ refresh: true },
		);

		expect(options).toEqual([
			expect.objectContaining({ name: "SP-A" }),
		]);
		expect(offlineState.setCalls).toEqual([]);
	});
});
