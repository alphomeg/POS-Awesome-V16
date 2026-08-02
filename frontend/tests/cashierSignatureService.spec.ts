import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiCall } = vi.hoisted(() => ({
	apiCall: vi.fn(),
}));

vi.mock("../src/posapp/services/api", () => ({
	default: {
		call: apiCall,
	},
}));

import {
	prepareOfflineCashSaleAuthorizations,
	reauthorizeOfflineCashSaleAuthorization,
	validateCashierSignature,
} from "../src/posapp/services/cashierSignatureService";

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
				type: "POST",
			},
		);
	});

	it("uses the bounded authorization endpoint only to prepare offline cash sales", async () => {
		apiCall.mockResolvedValue({ tickets: [] });

		await expect(
			prepareOfflineCashSaleAuthorizations(
				"Main POS",
				"2468",
				"Sales Invoice",
			),
		).resolves.toEqual({ tickets: [] });
		expect(apiCall).toHaveBeenCalledWith(
			"posawesome.posawesome.api.offline_sale_authorizations.issue_offline_cash_sale_authorizations",
			{
				pos_profile: "Main POS",
				pin: "2468",
				document_type: "Sales Invoice",
			},
			{
				timeoutMs: 10_000,
				type: "POST",
			},
		);
	});

	it("reauthorizes only one immutable queued command with a transient PIN and bearer", async () => {
		apiCall.mockResolvedValue({
			ticket: {
				authorization: "replacement-ticket-secret",
				client_request_id: "offline-request-1",
				owner_user: "cashier@example.com",
				expires_at: "2099-01-01T00:00:00+00:00",
				cashier: "cashier@example.com",
				cash_mode_of_payment: "Cash",
				maximum_amount: "5000",
				company_currency: "PKR",
				document_type: "Sales Invoice",
			},
			approval_level: "requires_reauthorization",
		});

		await expect(
			reauthorizeOfflineCashSaleAuthorization("Main POS", "2468", {
				clientRequestId: "offline-request-1",
				documentType: "Sales Invoice",
				invoice: { posa_client_request_id: "offline-request-1" },
				data: { client_request_id: "offline-request-1" },
				offlineSaleAuthorization: "expired-ticket-secret",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				approval_level: "requires_reauthorization",
				ticket: expect.objectContaining({
					client_request_id: "offline-request-1",
				}),
			}),
		);

		expect(apiCall).toHaveBeenCalledWith(
			"posawesome.posawesome.api.offline_sale_authorizations.reauthorize_offline_cash_sale_authorization",
			{
				pos_profile: "Main POS",
				pin: "2468",
				client_request_id: "offline-request-1",
				document_type: "Sales Invoice",
				invoice: { posa_client_request_id: "offline-request-1" },
				data: { client_request_id: "offline-request-1" },
				offline_sale_authorization: "expired-ticket-secret",
			},
			{
				timeoutMs: 10_000,
				type: "POST",
			},
		);
	});

	it("fails closed when reauthorization does not identify its fresh ticket owner", async () => {
		apiCall.mockResolvedValue({
			ticket: {
				authorization: "replacement-ticket-secret",
				client_request_id: "offline-request-1",
				document_type: "Sales Invoice",
			},
			approval_level: "requires_reauthorization",
		});

		await expect(
			reauthorizeOfflineCashSaleAuthorization("Main POS", "2468", {
				clientRequestId: "offline-request-1",
				documentType: "Sales Invoice",
				invoice: { posa_client_request_id: "offline-request-1" },
				data: { client_request_id: "offline-request-1" },
				offlineSaleAuthorization: "expired-ticket-secret",
			}),
		).rejects.toThrow("invalid ticket");
	});
});
