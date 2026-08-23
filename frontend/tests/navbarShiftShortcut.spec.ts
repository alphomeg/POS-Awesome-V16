import { describe, expect, it } from "vitest";

import navbarSource from "../src/posapp/components/Navbar.vue?raw";
import invoiceShortcutSource from "../src/posapp/components/pos/invoice/invoiceShortcuts.ts?raw";

describe("navbar shift keyboard contract", () => {
	it("routes the existing F7 shift event to the close-shift surface", () => {
		expect(invoiceShortcutSource).toContain(
			'this.eventBus.emit("open_shift_details")',
		);
		expect(navbarSource).toContain(
			"this.openShiftDetailsHandler = () => this.openCloseShift();",
		);
		expect(navbarSource).toContain(
			'this.eventBus.on("open_shift_details", this.openShiftDetailsHandler);',
		);
	});

	it("unregisters the F7 shift handler when the navbar unmounts", () => {
		expect(navbarSource).toContain(
			'this.eventBus.off("open_shift_details", this.openShiftDetailsHandler);',
		);
	});
});
