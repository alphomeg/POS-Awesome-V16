import { computed, ref } from "vue";
import { defineStore } from "pinia";

export interface TerminalEmployee {
	user: string;
	full_name: string;
	enabled?: number;
	is_current?: boolean;
	is_supervisor?: boolean;
}

export interface AuthoritativeTerminalState {
	pos_profile?: string;
	active_cashier?: string | null;
	locked?: boolean;
	verified_at?: string | null;
	locked_at?: string | null;
}

export type TerminalEmployeesLoadStatus =
	| "idle"
	| "loading"
	| "ready"
	| "error";

const normalizeEmployee = (cashier: TerminalEmployee): TerminalEmployee => ({
	user: String(cashier.user),
	full_name: String(cashier.full_name || cashier.user),
	enabled: Number(cashier.enabled ?? 1),
	is_current: Boolean(cashier.is_current),
	is_supervisor: Boolean(cashier.is_supervisor),
});

const TERMINAL_LOCKING_ENABLED = false;

const resolveSessionCashier = (): TerminalEmployee | null => {
	const frappeRef = (globalThis as any).frappe;
	const session = frappeRef?.session || {};
	const user = String(session.user || "").trim();
	if (!user || user === "Guest") return null;
	const roles = Array.isArray(frappeRef?.user_roles) ? frappeRef.user_roles : [];
	return normalizeEmployee({
		user,
		full_name: session.user_fullname || session.full_name || user,
		enabled: 1,
		is_current: true,
		is_supervisor: roles.includes("System Manager") || roles.includes("POS Manager"),
	});
};

export const useEmployeeStore = defineStore("employee", () => {
	const terminalEmployees = ref<TerminalEmployee[]>([]);
	const currentCashier = ref<TerminalEmployee | null>(resolveSessionCashier());
	const switchDialogOpen = ref(false);
	const lockDialogOpen = ref(TERMINAL_LOCKING_ENABLED);
	const terminalStateLoaded = ref(false);
	const terminalLockPending = ref(false);
	const terminalEmployeesLoadStatus =
		ref<TerminalEmployeesLoadStatus>("idle");
	const terminalEmployeesLoadError = ref("");
	const terminalEmployeesProfile = ref("");

	const currentCashierDisplay = computed(
		() =>
			currentCashier.value?.full_name || currentCashier.value?.user || "",
	);
	const isLocked = computed(() => lockDialogOpen.value);

	const setCurrentCashier = (cashier: TerminalEmployee | string | null) => {
		if (!cashier) {
			currentCashier.value = null;
			return;
		}

		const nextCashier =
			typeof cashier === "string"
				? terminalEmployees.value.find(
						(employee) => employee.user === cashier,
					) || null
				: normalizeEmployee(cashier);

		if (nextCashier) {
			currentCashier.value = nextCashier;
		}
	};

	const setSessionCashierFromFrappe = () => {
		const sessionCashier = resolveSessionCashier();
		if (!sessionCashier) return null;
		const listedCashier = terminalEmployees.value.find(
			(employee) => employee.user === sessionCashier.user,
		);
		currentCashier.value = listedCashier || sessionCashier;
		lockDialogOpen.value = false;
		terminalLockPending.value = false;
		return currentCashier.value;
	};

	const setTerminalEmployees = (employees: TerminalEmployee[] = []) => {
		terminalEmployees.value = Array.isArray(employees)
			? employees
					.filter((employee) => employee?.user)
					.map(normalizeEmployee)
			: [];
		terminalEmployeesLoadStatus.value = "ready";
		terminalEmployeesLoadError.value = "";

		if (currentCashier.value) {
			const refreshedCashier = terminalEmployees.value.find(
				(employee) => employee.user === currentCashier.value?.user,
			);
			currentCashier.value =
				refreshedCashier || (TERMINAL_LOCKING_ENABLED ? null : currentCashier.value);
		}
		if (!TERMINAL_LOCKING_ENABLED) {
			setSessionCashierFromFrappe();
		}
	};

	const beginTerminalEmployeesLoad = (profileName: string) => {
		terminalEmployeesProfile.value = String(profileName || "").trim();
		terminalEmployeesLoadStatus.value = "loading";
		terminalEmployeesLoadError.value = "";
		terminalEmployees.value = [];
		currentCashier.value = TERMINAL_LOCKING_ENABLED
			? null
			: currentCashier.value || resolveSessionCashier();
		lockDialogOpen.value = TERMINAL_LOCKING_ENABLED;
		terminalStateLoaded.value = false;
		if (TERMINAL_LOCKING_ENABLED) {
			switchDialogOpen.value = false;
		}
	};

	const completeTerminalEmployeesLoad = (
		profileName: string,
		employees: TerminalEmployee[] = [],
	) => {
		if (
			terminalEmployeesProfile.value !== String(profileName || "").trim()
		) {
			return false;
		}
		setTerminalEmployees(employees);
		terminalEmployeesLoadStatus.value = "ready";
		terminalEmployeesLoadError.value = "";
		return true;
	};

	const failTerminalEmployeesLoad = (
		profileName: string,
		message: string,
	) => {
		if (
			terminalEmployeesProfile.value !== String(profileName || "").trim()
		) {
			return false;
		}
		setTerminalEmployees([]);
		terminalEmployeesLoadStatus.value = "error";
		terminalEmployeesLoadError.value = String(message || "").trim();
		return true;
	};

	const resetTerminalEmployeesLoad = () => {
		setTerminalEmployees([]);
		terminalEmployeesProfile.value = "";
		terminalEmployeesLoadStatus.value = "idle";
		terminalEmployeesLoadError.value = "";
	};

	const applyTerminalState = (
		state: AuthoritativeTerminalState | null | undefined,
		verifiedCashier?: TerminalEmployee | null,
	) => {
		if (!TERMINAL_LOCKING_ENABLED) {
			setSessionCashierFromFrappe();
			lockDialogOpen.value = false;
			terminalLockPending.value = false;
			terminalStateLoaded.value = true;
			return;
		}

		const activeCashier = String(state?.active_cashier || "").trim();
		const candidate =
			verifiedCashier?.user === activeCashier
				? normalizeEmployee(verifiedCashier)
				: terminalEmployees.value.find(
						(employee) => employee.user === activeCashier,
					) ||
					(state?.locked === false && activeCashier
						? normalizeEmployee({
								user: activeCashier,
								full_name: activeCashier,
								enabled: 1,
							})
						: null);

		currentCashier.value = candidate;
		lockDialogOpen.value = state?.locked !== false || !candidate;
		terminalLockPending.value = false;
		terminalStateLoaded.value = true;
		if (lockDialogOpen.value) {
			switchDialogOpen.value = false;
		}
	};

	const applyVerifiedCashier = (
		cashier: TerminalEmployee & {
			terminal_state?: AuthoritativeTerminalState;
		},
	) => {
		const state = cashier?.terminal_state;
		if (!TERMINAL_LOCKING_ENABLED) {
			if (cashier?.user) {
				setCurrentCashier(cashier);
			}
			lockDialogOpen.value = false;
			terminalLockPending.value = false;
			terminalStateLoaded.value = true;
			return;
		}
		if (
			!cashier?.user ||
			state?.locked !== false ||
			state?.active_cashier !== cashier.user
		) {
			throw new Error(
				"The server did not confirm the active terminal cashier.",
			);
		}
		applyTerminalState(state, cashier);
	};

	const ensureCurrentCashier = () => {
		if (!TERMINAL_LOCKING_ENABLED) {
			if (!currentCashier.value) {
				setSessionCashierFromFrappe();
			}
			lockDialogOpen.value = false;
			terminalLockPending.value = false;
			return;
		}
		if (!currentCashier.value) return;
		const serverListedCashier = terminalEmployees.value.find(
			(employee) => employee.user === currentCashier.value?.user,
		);
		currentCashier.value = serverListedCashier || null;
		if (!currentCashier.value) {
			lockDialogOpen.value = true;
		}
	};

	const openEmployeeSwitch = () => {
		ensureCurrentCashier();
		if (!lockDialogOpen.value || !TERMINAL_LOCKING_ENABLED) {
			switchDialogOpen.value = true;
		}
	};

	const closeEmployeeSwitch = () => {
		switchDialogOpen.value = false;
	};

	const lockTerminal = () => {
		switchDialogOpen.value = false;
		lockDialogOpen.value = TERMINAL_LOCKING_ENABLED;
	};

	const markTerminalLockPending = () => {
		if (!TERMINAL_LOCKING_ENABLED) {
			lockDialogOpen.value = false;
			terminalLockPending.value = false;
			switchDialogOpen.value = false;
			return;
		}
		lockTerminal();
		terminalLockPending.value = true;
	};

	const unlockTerminal = (
		cashier: TerminalEmployee & {
			terminal_state?: AuthoritativeTerminalState;
		},
	) => {
		applyVerifiedCashier(cashier);
	};

	return {
		terminalEmployees,
		currentCashier,
		currentCashierDisplay,
		switchDialogOpen,
		lockDialogOpen,
		terminalStateLoaded,
		terminalLockPending,
		terminalEmployeesLoadStatus,
		terminalEmployeesLoadError,
		terminalEmployeesProfile,
		isLocked,
		terminalLockingEnabled: TERMINAL_LOCKING_ENABLED,
		setTerminalEmployees,
		setSessionCashierFromFrappe,
		beginTerminalEmployeesLoad,
		completeTerminalEmployeesLoad,
		failTerminalEmployeesLoad,
		resetTerminalEmployeesLoad,
		setCurrentCashier,
		applyTerminalState,
		applyVerifiedCashier,
		ensureCurrentCashier,
		openEmployeeSwitch,
		closeEmployeeSwitch,
		lockTerminal,
		markTerminalLockPending,
		unlockTerminal,
	};
});

export default useEmployeeStore;
