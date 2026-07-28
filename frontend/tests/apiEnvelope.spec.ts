// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import api from "../src/posapp/services/api";

describe("api envelope handling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("frappe", {
			call: vi.fn(),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns a timeout envelope and passes a request_id", async () => {
		(frappe.call as any).mockImplementation(() => undefined);

		const pending = api.callEnvelope(
			"pos.test.timeout",
			{},
			{ timeoutMs: 10 },
		);
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "TIMEOUT",
				retryable: true,
			},
		});
		expect(result.requestId).toEqual(expect.stringMatching(/^posa-/));
		expect(frappe.call).toHaveBeenCalledWith(
			expect.objectContaining({
				args: expect.objectContaining({ request_id: result.requestId }),
			}),
		);
	});

	it("normalizes transport errors into retryable envelopes", async () => {
		(frappe.call as any).mockImplementation(({ error }: any) => {
			error({ status: 503, statusText: "Service Unavailable" });
		});

		const result = await api.callEnvelope("pos.test.http_error");

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "HTTP_ERROR",
				message: "Service Unavailable",
				retryable: true,
			},
		});
	});

	it.each([
		[400, "Bad Request"],
		[409, "Conflict"],
	])(
		"keeps an unstructured HTTP %s failure classified as HTTP_ERROR",
		async (status, statusText) => {
			(frappe.call as any).mockImplementation(({ error }: any) => {
				error({ status, statusText });
			});

			const result = await api.callEnvelope("pos.test.http_error");

			expect(result).toMatchObject({
				ok: false,
				error: {
					code: "HTTP_ERROR",
					message: statusText,
					retryable: false,
				},
			});
		},
	);

	it("preserves an explicit authoritative validation envelope from an HTTP error callback", async () => {
		(frappe.call as any).mockImplementation(({ error }: any) => {
			error({
				status: 400,
				statusText: "Bad Request",
				responseJSON: {
					message: {
						ok: false,
						data: null,
						error: {
							code: "VALIDATION_ERROR",
							message: "Customer is required",
							retryable: false,
						},
						requestId: "server-validation-001",
						serverTime: "2026-07-20T12:00:00Z",
					},
				},
			});
		});

		const result = await api.callEnvelope("pos.test.validation_http_error");

		expect(result).toEqual({
			ok: false,
			data: null,
			error: {
				code: "VALIDATION_ERROR",
				message: "Customer is required",
				retryable: false,
			},
			requestId: "server-validation-001",
			serverTime: "2026-07-20T12:00:00Z",
		});
	});

	it("normalizes a raw Frappe cashier PIN validation response without exposing its traceback", async () => {
		(frappe.call as any).mockImplementation(({ error }: any) => {
			error({
				status: 417,
				statusText: "Expectation Failed",
				responseText: JSON.stringify({
					exception:
						"frappe.exceptions.ValidationError: Invalid cashier PIN.",
					exc_type: "ValidationError",
					exc: "Traceback (most recent call last): secret internal stack",
					_server_messages: JSON.stringify([
						JSON.stringify({
							message: "Invalid cashier PIN.",
							indicator: "red",
						}),
					]),
				}),
			});
		});

		const result = await api.callEnvelope("pos.test.cashier_pin_error");

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "CASHIER_PIN_REJECTED",
				message: "Invalid cashier PIN.",
				retryable: false,
			},
		});
		expect(JSON.stringify(result)).not.toContain("Traceback");
	});

	it("normalizes business-rule responses into non-retryable envelopes", async () => {
		(frappe.call as any).mockImplementation(({ callback }: any) => {
			callback({
				message: {
					error: {
						code: "VALIDATION_ERROR",
						message: "Customer is required",
					},
				},
			});
		});

		const result = await api.callEnvelope("pos.test.business_error");

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "Customer is required",
				retryable: false,
			},
		});
	});
});
