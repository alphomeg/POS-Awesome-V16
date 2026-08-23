const normalizeText = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";

export interface ProfileRegistrationCustomerOptions {
	previousProfileName?: unknown;
	nextProfileName?: unknown;
	currentCustomer?: unknown;
	selectedCustomer?: unknown;
	defaultCustomer?: unknown;
}

/**
 * Resolve the customer while reactive POS profile data is being registered.
 *
 * Profile/bootstrap data can arrive after a cashier has already selected a
 * customer. Re-registering the same profile must not reset that selection to
 * the profile's walk-in customer. A real profile switch still starts from the
 * new profile default so customer state cannot leak across profiles.
 */
export function resolveProfileRegistrationCustomer({
	previousProfileName,
	nextProfileName,
	currentCustomer,
	selectedCustomer,
	defaultCustomer,
}: ProfileRegistrationCustomerOptions): string {
	const previous = normalizeText(previousProfileName);
	const next = normalizeText(nextProfileName);
	const selected = normalizeText(selectedCustomer);
	const current = normalizeText(currentCustomer);
	const fallback = normalizeText(defaultCustomer);

	if (!previous) {
		return selected || current || fallback;
	}

	if (previous === next) {
		return selected || current || fallback;
	}

	return fallback;
}
