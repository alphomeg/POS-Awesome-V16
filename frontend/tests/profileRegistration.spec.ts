import { describe, expect, it } from "vitest";
import { resolveProfileRegistrationCustomer } from "../src/posapp/utils/profileRegistration";

describe("POS profile registration customer resolution", () => {
	it("preserves a customer selected before initial profile registration completes", () => {
		expect(
			resolveProfileRegistrationCustomer({
				previousProfileName: "",
				nextProfileName: "Supervisor POS",
				selectedCustomer: "VITAL PHARMACY , BRANCH 2 (1413)",
				defaultCustomer: "Walk-in Customer",
			}),
		).toBe("VITAL PHARMACY , BRANCH 2 (1413)");
	});

	it("preserves the active customer when the same profile is refreshed", () => {
		expect(
			resolveProfileRegistrationCustomer({
				previousProfileName: "Supervisor POS",
				nextProfileName: "Supervisor POS",
				currentCustomer: "VITAL PHARMACY , BRANCH 2 (1413)",
				defaultCustomer: "Walk-in Customer",
			}),
		).toBe("VITAL PHARMACY , BRANCH 2 (1413)");
	});

	it("uses the new default when the actual profile changes", () => {
		expect(
			resolveProfileRegistrationCustomer({
				previousProfileName: "Counter POS",
				nextProfileName: "Supervisor POS",
				selectedCustomer: "Old Profile Customer",
				defaultCustomer: "Supervisor Walk-in",
			}),
		).toBe("Supervisor Walk-in");
	});
});
