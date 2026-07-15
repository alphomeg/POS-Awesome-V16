import { describe, expect, it } from "vitest";

import paymentsSource from "../src/posapp/components/pos/Payments.vue?raw";

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
});
