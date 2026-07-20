import { describe, expect, it } from "vitest";

import { shouldUsePaymentDialog } from "../src/posapp/utils/paymentHostOwnership";

describe("payment host ownership", () => {
	it("keeps a mobile inline payment owner mounted across lock and resize", () => {
		expect(
			shouldUsePaymentDialog({
				checkoutLocked: true,
				owner: "inline",
				windowWidth: 480,
			}),
		).toBe(false);
		expect(
			shouldUsePaymentDialog({
				checkoutLocked: true,
				owner: "inline",
				windowWidth: 1440,
			}),
		).toBe(false);
	});

	it.each(["x", "p"])(
		"keeps the Alt+%s shortcut Payments owner mounted across lock and resize",
		() => {
			expect(
				shouldUsePaymentDialog({
					checkoutLocked: true,
					owner: "shortcut",
					windowWidth: 480,
				}),
			).toBe(false);
			expect(
				shouldUsePaymentDialog({
					checkoutLocked: true,
					owner: "shortcut",
					windowWidth: 1440,
				}),
			).toBe(false);
		},
	);

	it("uses a visible dialog for a startup durable recovery without a live owner", () => {
		expect(
			shouldUsePaymentDialog({
				checkoutLocked: true,
				owner: null,
				windowWidth: 480,
			}),
		).toBe(true);
	});

	it("returns to responsive dialog selection after the lock is released", () => {
		expect(
			shouldUsePaymentDialog({
				checkoutLocked: false,
				owner: "inline",
				windowWidth: 480,
			}),
		).toBe(false);
		expect(
			shouldUsePaymentDialog({
				checkoutLocked: false,
				owner: "inline",
				windowWidth: 1440,
			}),
		).toBe(true);
	});
});
