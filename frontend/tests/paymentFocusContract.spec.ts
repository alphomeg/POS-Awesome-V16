import { describe, expect, it } from "vitest";

import paymentsSource from "../src/posapp/components/pos/Payments.vue?raw";
import posSource from "../src/posapp/components/pos/shell/Pos.vue?raw";

describe("payment focus contract", () => {
	it("stabilizes the first keyboard target after hydrated payment rows render", () => {
		const hydrationHandler = paymentsSource.slice(
			paymentsSource.indexOf('eventBus.on("send_invoice_doc_payment"'),
			paymentsSource.indexOf('eventBus.on("register_pos_profile"'),
		);
		const focusRecovery = paymentsSource.slice(
			paymentsSource.indexOf("const paymentFocusRetryDelays"),
			paymentsSource.indexOf("const handleShowPayment"),
		);

		expect(hydrationHandler).toContain("stabilizePaymentKeyboardFocus();");
		expect(focusRecovery).toContain("nextTick(() =>");
		expect(focusRecovery).toContain("[0, 100, 300, 700, 1500]");
		expect(focusRecovery).toContain(
			"paymentRoot.value?.contains(document.activeElement)",
		);
		expect(focusRecovery).toContain("focusFirstPaymentTarget();");
	});

	it("returns shortcut submissions to the active invoice item entry", () => {
		expect(paymentsSource).toContain(
			'eventBus.emit("focus_invoice_item_entry");',
		);
		expect(posSource).toContain(
			'eventBus.on("focus_invoice_item_entry", focusInvoiceItemEntry);',
		);
		expect(posSource).toContain(
			"invoicePanel.value?.focusCounterGridEntry?.();",
		);
		expect(posSource).toContain(
			'eventBus.off("focus_invoice_item_entry", focusInvoiceItemEntry);',
		);
	});
});
