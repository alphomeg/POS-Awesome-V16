import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useEmployeeStore } from "../src/posapp/stores/employeeStore";

describe("employeeStore", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		(globalThis as any).frappe = {
			session: {
				user: "cashier@example.com",
				user_fullname: "Main Cashier",
			},
		};
	});

	it("starts unlocked with the logged-in ERPNext user as cashier", () => {
		const store = useEmployeeStore();

		store.setTerminalEmployees([
			{
				user: "cashier@example.com",
				full_name: "Main Cashier",
			},
			{
				user: "backup@example.com",
				full_name: "Backup Cashier",
			},
		]);

		expect(store.currentCashier?.user).toBe("cashier@example.com");
		expect(store.currentCashierDisplay).toBe("Main Cashier");
		expect(store.isLocked).toBe(false);

		store.applyTerminalState({
			pos_profile: "Main POS",
			active_cashier: "backup@example.com",
			locked: false,
		});

		expect(store.currentCashier?.user).toBe("cashier@example.com");
		expect(store.isLocked).toBe(false);
	});

	it("keeps terminal locking disabled while preserving cashier switching", () => {
		const store = useEmployeeStore();
		store.setTerminalEmployees([
			{ user: "cashier@example.com", full_name: "Main Cashier" },
		]);

		store.openEmployeeSwitch();
		expect(store.switchDialogOpen).toBe(true);

		store.lockTerminal();
		expect(store.switchDialogOpen).toBe(false);
		expect(store.lockDialogOpen).toBe(false);
		expect(store.isLocked).toBe(false);

		store.applyTerminalState(null);
		expect(store.lockDialogOpen).toBe(false);
		expect(store.isLocked).toBe(false);
	});

	it("derives the active cashier from the browser session while terminal locking is disabled", () => {
		const store = useEmployeeStore();

		store.setTerminalEmployees([
			{
				user: "cashier@example.com",
				full_name: "Main Cashier",
				is_supervisor: true,
			},
		]);

		expect(store.currentCashier?.user).toBe("cashier@example.com");
		expect(store.currentCashier?.is_supervisor).toBe(true);
		expect(store.isLocked).toBe(false);

		store.applyVerifiedCashier({
			user: "cashier@example.com",
			full_name: "Main Cashier",
			is_supervisor: true,
			terminal_state: {
				active_cashier: "attacker@example.com",
				locked: false,
			},
		});

		expect(store.currentCashier?.user).toBe("cashier@example.com");
		expect(store.isLocked).toBe(false);
	});

	it("stays unlocked while loading cashiers and ignores stale profile results", () => {
		const store = useEmployeeStore();

		store.beginTerminalEmployeesLoad("Main POS");
		expect(store.terminalEmployeesLoadStatus).toBe("loading");
		expect(store.terminalEmployees).toEqual([]);
		expect(store.currentCashier?.user).toBe("cashier@example.com");
		expect(store.isLocked).toBe(false);

		store.beginTerminalEmployeesLoad("Backup POS");
		expect(
			store.completeTerminalEmployeesLoad("Main POS", [
				{
					user: "stale@example.com",
					full_name: "Stale Cashier",
				},
			]),
		).toBe(false);
		expect(store.terminalEmployees).toEqual([]);

		expect(
			store.completeTerminalEmployeesLoad("Backup POS", [
				{
					user: "backup@example.com",
					full_name: "Backup Cashier",
				},
			]),
		).toBe(true);
		expect(store.terminalEmployeesLoadStatus).toBe("ready");
		expect(store.terminalEmployees.map((cashier) => cashier.user)).toEqual([
			"backup@example.com",
		]);

		store.resetTerminalEmployeesLoad();
		expect(store.terminalEmployeesLoadStatus).toBe("idle");
		expect(store.terminalEmployeesProfile).toBe("");
		expect(store.terminalEmployees).toEqual([]);
	});

	it("keeps the logged-in cashier when cashier loading fails", () => {
		const store = useEmployeeStore();
		store.setTerminalEmployees([
			{ user: "cashier@example.com", full_name: "Main Cashier" },
		]);
		store.beginTerminalEmployeesLoad("Main POS");

		expect(
			store.failTerminalEmployeesLoad(
				"Main POS",
				"Unable to load authorized cashiers.",
			),
		).toBe(true);
		expect(store.terminalEmployees).toEqual([]);
		expect(store.currentCashier?.user).toBe("cashier@example.com");
		expect(store.isLocked).toBe(false);
		expect(store.terminalEmployeesLoadStatus).toBe("error");
		expect(store.terminalEmployeesLoadError).toContain("Unable to load");
	});
});
