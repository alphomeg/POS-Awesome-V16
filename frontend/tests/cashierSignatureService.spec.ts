import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiCall } = vi.hoisted(() => ({
	apiCall: vi.fn(),
}));

vi.mock("../src/posapp/services/api", () => ({
	default: {
		call: apiCall,
	},
}));

import { validateCashierSignature } from "../src/posapp/services/cashierSignatureService";

describe("cashierSignatureService", () => {
	beforeEach(() => {
		apiCall.mockReset();
	});

	it("sends the PIN only to the bounded validation preflight", async () => {
		apiCall.mockResolvedValue({ valid: true });

		await expect(
			validateCashierSignature("Main POS", "2468"),
		).resolves.toEqual({ valid: true });
		expect(apiCall).toHaveBeenCalledWith(
			"posawesome.posawesome.api.employees.validate_cashier_signature",
			{
				pos_profile: "Main POS",
				pin: "2468",
			},
			{
				timeoutMs: 10_000,
			},
		);
	});
});
