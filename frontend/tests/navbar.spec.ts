// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { shallowMount } from "@vue/test-utils";

vi.mock("../src/posapp/composables/core/useRtl", () => ({
	useRtl: () => ({
		isRtl: false,
		rtlStyles: {},
		rtlClasses: [],
	}),
}));

vi.mock("../src/offline/index", () => ({
	clearDerivedOfflineCaches: vi.fn(async () => undefined),
	isOffline: vi.fn(() => false),
}));

vi.mock("../src/utils/clearAllCaches", () => ({
	getPosStateInventory: vi.fn(async () => ({
		operational: {
			invoiceOutbox: 0,
			writeQueue: 0,
			legacyQueue: 0,
			intentJournals: 0,
			activeRecoveryPointers: 0,
		},
		cacheNames: [],
	})),
	repairPosAssets: vi.fn(async () => undefined),
	resetLocalPosOwnedState: vi.fn(async () => undefined),
}));

import Navbar from "../src/posapp/components/Navbar.vue";
import { useEmployeeStore } from "../src/posapp/stores/employeeStore";
import { repairPosAssets } from "../src/utils/clearAllCaches";

describe("Navbar supervisor access", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.stubGlobal("__", (value: string) => value);
		vi.stubGlobal("frappe", {
			session: {
				user: "cashier@example.com",
				user_fullname: "Main Cashier",
			},
			boot: {
				sysdefaults: { company: "Test Co" },
				website_settings: {},
			},
			call: vi.fn(async ({ method }: { method: string }) => {
				if (method.endsWith("get_terminal_employees")) {
					return {
						message: [
							{
								user: "cashier@example.com",
								full_name: "Main Cashier",
								is_current: true,
								is_supervisor: false,
							},
						],
					};
				}
				return {
					message: {
						pos_profile: "Main POS",
						active_cashier: "cashier@example.com",
						locked: method.endsWith("lock_terminal"),
					},
				};
			}),
		});
	});

	it("shows the dashboard drawer item only for POS supervisors", async () => {
		const employeeStore = useEmployeeStore();
		employeeStore.setCurrentCashier({
			user: "cashier@example.com",
			full_name: "Main Cashier",
			is_supervisor: false,
		});

		const wrapper = shallowMount(Navbar, {
			props: {
				posProfile: { name: "Main POS" },
			},
			global: {
				mocks: {
					__: (value: string) => value,
				},
				stubs: {
					NavbarAppBar: true,
					NavbarDrawer: true,
					NavbarMenu: true,
					NotificationBell: true,
					StatusIndicator: true,
					CacheUsageMeter: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});

		await Promise.resolve();
		expect(
			(wrapper.vm as any).items.some(
				(item: any) => item.to === "/dashboard",
			),
		).toBe(false);

		employeeStore.setCurrentCashier({
			user: "cashier@example.com",
			full_name: "Main Cashier",
			is_supervisor: true,
		});
		await (wrapper.vm as any).$nextTick();

		expect(
			(wrapper.vm as any).items.some(
				(item: any) => item.to === "/dashboard",
			),
		).toBe(true);
	});

	it("shows the gift cards drawer item when gift cards are enabled on the POS profile", async () => {
		const employeeStore = useEmployeeStore();
		employeeStore.setCurrentCashier({
			user: "cashier@example.com",
			full_name: "Main Cashier",
			is_supervisor: true,
		});

		const wrapper = shallowMount(Navbar, {
			props: {
				posProfile: { name: "Main POS", posa_use_gift_cards: 1 },
			},
			global: {
				mocks: {
					__: (value: string) => value,
				},
				stubs: {
					NavbarAppBar: true,
					NavbarDrawer: true,
					NavbarMenu: true,
					NotificationBell: true,
					StatusIndicator: true,
					CacheUsageMeter: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});

		await Promise.resolve();
		expect(
			(wrapper.vm as any).items.some(
				(item: any) => item.to === "/gift-cards",
			),
		).toBe(true);
	});

	it("passes a footer settings launcher to the drawer and opens the settings panel from it", async () => {
		const employeeStore = useEmployeeStore();
		employeeStore.setCurrentCashier({
			user: "cashier@example.com",
			full_name: "Main Cashier",
			is_supervisor: true,
		});

		const wrapper = shallowMount(Navbar, {
			props: {
				posProfile: {
					name: "Main POS",
					posa_enable_customer_display: 1,
				},
				manualOffline: false,
				networkOnline: true,
				serverOnline: true,
			},
			global: {
				mocks: {
					__: (value: string) => value,
				},
				stubs: {
					NotificationBell: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});

		await Promise.resolve();
		(wrapper.vm as any).drawer = true;
		await nextTick();

		expect(
			wrapper.get('[data-test="drawer-footer-action"]').text(),
		).toContain("Settings");

		await wrapper
			.get('[data-test="drawer-footer-action"]')
			.trigger("click");
		await nextTick();

		expect((wrapper.vm as any).drawer).toBe(false);
		expect((wrapper.vm as any).settingsPanelOpen).toBe(true);
	});

	it("shows an error toast instead of a false success toast when asset repair fails", async () => {
		const employeeStore = useEmployeeStore();
		employeeStore.setCurrentCashier({
			user: "cashier@example.com",
			full_name: "Main Cashier",
			is_supervisor: true,
		});

		(repairPosAssets as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("boom"),
		);

		const wrapper = shallowMount(Navbar, {
			props: {
				posProfile: { name: "Main POS" },
			},
			global: {
				mocks: {
					__: (value: string) => value,
				},
				stubs: {
					NavbarAppBar: true,
					NavbarDrawer: true,
					NavbarMenu: true,
					NotificationBell: true,
					StatusIndicator: true,
					CacheUsageMeter: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});

		await (wrapper.vm as any).repairAppAssets();

		const shownTitles = (wrapper.vm as any).toastStore.history.map(
			(entry: { title: string }) => entry.title,
		);
		expect(shownTitles).toContain("App asset repair failed");
		expect(shownTitles).not.toContain("POS app assets repaired");
	});

	it("ignores lock actions while terminal locking is disabled", async () => {
		const employeeStore = useEmployeeStore();
		employeeStore.setTerminalEmployees([
			{
				user: "cashier@example.com",
				full_name: "Main Cashier",
			},
		]);
		employeeStore.applyTerminalState({
			active_cashier: "cashier@example.com",
			locked: false,
		});

		const wrapper = shallowMount(Navbar, {
			props: { posProfile: { name: "Main POS" } },
			global: {
				mocks: { __: (value: string) => value },
				stubs: {
					NavbarAppBar: true,
					NavbarDrawer: true,
					NavbarMenu: true,
					NotificationBell: true,
					StatusIndicator: true,
					CacheUsageMeter: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});
		await (wrapper.vm as any).fetchTerminalEmployees();
		(frappe.call as ReturnType<typeof vi.fn>).mockClear();

		const result = await (wrapper.vm as any).lockPosScreen();

		expect(result).toBe(true);
		expect(employeeStore.isLocked).toBe(false);
		expect(employeeStore.terminalLockPending).toBe(false);
		expect(frappe.call).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it("surfaces cashier loading failures and recovers without retaining stale users", async () => {
		const employeeStore = useEmployeeStore();
		(frappe.call as ReturnType<typeof vi.fn>).mockImplementation(
			async ({ method }: { method: string }) => {
				if (method.endsWith("get_terminal_employees")) {
					throw new Error("temporary network failure");
				}
				return {
					message: {
						pos_profile: "Main POS",
						active_cashier: null,
						locked: true,
					},
				};
			},
		);

		const wrapper = shallowMount(Navbar, {
			props: { posProfile: { name: "Main POS" } },
			global: {
				mocks: { __: (value: string) => value },
				stubs: {
					NavbarAppBar: true,
					NavbarDrawer: true,
					NavbarMenu: true,
					NotificationBell: true,
					StatusIndicator: true,
					CacheUsageMeter: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});

		await vi.waitFor(() => {
			expect(employeeStore.terminalEmployeesLoadStatus).toBe("error");
		});
		expect(employeeStore.terminalEmployees).toEqual([]);
		expect(employeeStore.terminalEmployeesLoadError).toContain(
			"Unable to load cashiers",
		);
		expect(employeeStore.currentCashier?.user).toBe("cashier@example.com");
		expect(employeeStore.isLocked).toBe(false);

		(frappe.call as ReturnType<typeof vi.fn>).mockImplementation(
			async ({ method }: { method: string }) => {
				if (method.endsWith("get_terminal_employees")) {
					return {
						message: [
							{
								user: "cashier@example.com",
								full_name: "Main Cashier",
							},
						],
					};
				}
				return {
					message: {
						pos_profile: "Main POS",
						active_cashier: null,
						locked: true,
					},
				};
			},
		);

		await (wrapper.vm as any).fetchTerminalEmployees();

		expect(employeeStore.terminalEmployeesLoadStatus).toBe("ready");
		expect(
			employeeStore.terminalEmployees.map((cashier) => cashier.user),
		).toEqual(["cashier@example.com"]);
		expect(employeeStore.terminalEmployeesLoadError).toBe("");
		wrapper.unmount();
	});

	it("publishes authorized cashiers without requesting terminal state", async () => {
		const employeeStore = useEmployeeStore();
		(frappe.call as ReturnType<typeof vi.fn>).mockImplementation(
			({ method }: { method: string }) => {
				if (method.endsWith("get_terminal_employees")) {
					return Promise.resolve({
						message: [
							{
								user: "cashier@example.com",
								full_name: "Main Cashier",
							},
						],
					});
				}
				throw new Error(`Unexpected terminal method: ${method}`);
			},
		);

		const wrapper = shallowMount(Navbar, {
			props: { posProfile: { name: "Main POS" } },
			global: {
				mocks: { __: (value: string) => value },
				stubs: {
					NavbarAppBar: true,
					NavbarDrawer: true,
					NavbarMenu: true,
					NotificationBell: true,
					StatusIndicator: true,
					CacheUsageMeter: true,
					AboutDialog: true,
					EmployeeSwitchDialog: true,
					OfflineInvoicesDialog: true,
					ServerUsageGadget: true,
					DatabaseUsageGadget: true,
					VDialog: true,
					VCard: true,
					VCardTitle: true,
					VCardText: true,
					VSnackbar: true,
					VBtn: true,
					VProgressCircular: true,
				},
			},
		});

		await vi.waitFor(() => {
			expect(employeeStore.terminalEmployeesLoadStatus).toBe("ready");
		});
		expect(
			employeeStore.terminalEmployees.map((cashier) => cashier.user),
		).toEqual(["cashier@example.com"]);
		expect(employeeStore.isLocked).toBe(false);
		expect(employeeStore.terminalStateLoaded).toBe(true);
		expect(frappe.call).toHaveBeenCalledWith({
			method: "posawesome.posawesome.api.employees.get_terminal_employees",
			args: { pos_profile: "Main POS" },
		});
		wrapper.unmount();
	});

	it("turns a timed-out cashier request into an actionable load error", async () => {
		vi.useFakeTimers();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		let wrapper: ReturnType<typeof shallowMount> | undefined;
		try {
			const employeeStore = useEmployeeStore();
			(frappe.call as ReturnType<typeof vi.fn>).mockImplementation(
				({ method }: { method: string }) => {
					if (method.endsWith("get_terminal_employees")) {
						return new Promise(() => undefined);
					}
					return Promise.resolve({
						message: {
							pos_profile: "Main POS",
							active_cashier: null,
							locked: true,
						},
					});
				},
			);

			wrapper = shallowMount(Navbar, {
				props: { posProfile: { name: "Main POS" } },
				global: {
					mocks: { __: (value: string) => value },
					stubs: {
						NavbarAppBar: true,
						NavbarDrawer: true,
						NavbarMenu: true,
						NotificationBell: true,
						StatusIndicator: true,
						CacheUsageMeter: true,
						AboutDialog: true,
						EmployeeSwitchDialog: true,
						OfflineInvoicesDialog: true,
						ServerUsageGadget: true,
						DatabaseUsageGadget: true,
						VDialog: true,
						VCard: true,
						VCardTitle: true,
						VCardText: true,
						VSnackbar: true,
						VBtn: true,
						VProgressCircular: true,
					},
				},
			});

			await Promise.resolve();
			await Promise.resolve();
			expect(employeeStore.terminalEmployeesLoadStatus).toBe("loading");

			await vi.advanceTimersByTimeAsync(15_000);
			await nextTick();

			expect(employeeStore.terminalEmployeesLoadStatus).toBe("error");
			expect(employeeStore.terminalEmployees).toEqual([]);
			expect(employeeStore.terminalEmployeesLoadError).toContain(
				"Unable to load cashiers",
			);
			expect(consoleError).toHaveBeenCalledWith(
				"Failed to load terminal employees",
				expect.objectContaining({
					message: "Cashier list request timed out.",
				}),
			);
		} finally {
			wrapper?.unmount();
			consoleError.mockRestore();
			vi.useRealTimers();
		}
	});
});
