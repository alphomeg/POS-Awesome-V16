// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildInvoiceRecoveryCartFingerprint,
	claimInvoiceRecoveryClientEffects,
	clearActiveInvoiceSubmissionRecovery,
	clearInvoiceRecoveryClientEffects,
	getActiveInvoiceSubmissionRecovery,
	hasInvoiceRecoveryClientEffects,
	persistActiveInvoiceSubmissionRecovery,
	resetInvoiceRecoveryMemoryForTests,
	resetInvoiceRecoveryStateForTests,
} from "../src/posapp/composables/pos/payments/recoveryState";

describe("durable invoice recovery state", () => {
	beforeEach(() => {
		resetInvoiceRecoveryStateForTests();
	});

	it("restores the active request and effects claim after an in-memory reload", () => {
		persistActiveInvoiceSubmissionRecovery({
			requestId: "req-storage-reload",
			invoiceName: "LOCAL-STORAGE-1",
			posProfile: "Main POS",
			company: "Test Company",
			user: "cashier@example.test",
			cartFingerprint: "cart-fingerprint-v1",
			printRequested: true,
		});
		expect(claimInvoiceRecoveryClientEffects("req-storage-reload")).toBe(
			true,
		);

		resetInvoiceRecoveryMemoryForTests();

		expect(getActiveInvoiceSubmissionRecovery()).toEqual(
			expect.objectContaining({
				requestId: "req-storage-reload",
				invoiceName: "LOCAL-STORAGE-1",
				posProfile: "Main POS",
				company: "Test Company",
				user: "cashier@example.test",
				cartFingerprint: "cart-fingerprint-v1",
				printRequested: true,
			}),
		);
		expect(hasInvoiceRecoveryClientEffects("req-storage-reload")).toBe(
			true,
		);
		expect(claimInvoiceRecoveryClientEffects("req-storage-reload")).toBe(
			false,
		);
	});

	it("builds a deterministic semantic cart fingerprint", () => {
		const first = buildInvoiceRecoveryCartFingerprint({
			name: "LOCAL-CART-1",
			doctype: "Sales Invoice",
			company: "Test Company",
			items: [
				{ posa_row_id: "row-1", item_code: "ITEM-1", qty: 2, rate: 5 },
			],
			payments: [{ mode_of_payment: "Cash", amount: 10 }],
			grand_total: 10,
		});
		const same = buildInvoiceRecoveryCartFingerprint({
			name: "LOCAL-CART-1",
			doctype: "Sales Invoice",
			company: "Test Company",
			items: [
				{
					posa_row_id: "row-1",
					item_code: "ITEM-1",
					qty: "2",
					rate: "5",
				},
			],
			payments: [{ mode_of_payment: "Cash", amount: "10" }],
			grand_total: "10",
		});
		const changed = buildInvoiceRecoveryCartFingerprint({
			name: "LOCAL-CART-1",
			doctype: "Sales Invoice",
			company: "Test Company",
			items: [
				{ posa_row_id: "row-1", item_code: "ITEM-1", qty: 3, rate: 5 },
			],
			payments: [{ mode_of_payment: "Cash", amount: 15 }],
			grand_total: 15,
		});

		expect(same).toBe(first);
		expect(changed).not.toBe(first);
	});

	it("fails closed when the active recovery pointer cannot be persisted", () => {
		const setItem = Storage.prototype.setItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(function (key, value) {
				if (key === "posa_active_invoice_submission_recovery_v1") {
					throw new Error("storage unavailable");
				}
				return setItem.call(this, key, value);
			});

		try {
			expect(() =>
				persistActiveInvoiceSubmissionRecovery({
					requestId: "req-pointer-failure",
					invoiceName: "LOCAL-POINTER-FAILURE",
					printRequested: false,
				}),
			).toThrow(/durably save the active/i);
			expect(getActiveInvoiceSubmissionRecovery()).toBeNull();
		} finally {
			storageSpy.mockRestore();
		}
	});

	it("fails closed when the effects claim cannot be persisted", () => {
		const setItem = Storage.prototype.setItem;
		const storageSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(function (key, value) {
				if (
					key.startsWith("posa_invoice_recovery_client_effects_v1::")
				) {
					throw new Error("storage unavailable");
				}
				return setItem.call(this, key, value);
			});

		try {
			expect(() =>
				claimInvoiceRecoveryClientEffects("req-effects-failure"),
			).toThrow(/durably claim the client effects/i);
			expect(hasInvoiceRecoveryClientEffects("req-effects-failure")).toBe(
				false,
			);
		} finally {
			storageSpy.mockRestore();
		}
	});

	it("cleans a completed effects marker only after the pointer is cleared", () => {
		persistActiveInvoiceSubmissionRecovery({
			requestId: "req-completed-cleanup",
			invoiceName: "LOCAL-COMPLETED-CLEANUP",
			printRequested: false,
		});
		expect(claimInvoiceRecoveryClientEffects("req-completed-cleanup")).toBe(
			true,
		);
		expect(
			clearActiveInvoiceSubmissionRecovery("req-completed-cleanup"),
		).toBe(true);
		expect(clearInvoiceRecoveryClientEffects("req-completed-cleanup")).toBe(
			true,
		);
		expect(hasInvoiceRecoveryClientEffects("req-completed-cleanup")).toBe(
			false,
		);
	});
});
