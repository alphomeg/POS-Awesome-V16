import { describe, expect, it } from "vitest";

import source from "../src/posapp/components/pos/flows/InvoiceManagement.vue?raw";

describe("Invoice Management keyboard tabs", () => {
	it("owns standard tablist navigation before Vuetify can swallow it", () => {
		expect(source).toContain('@keydown.capture="handleInvoiceTabKeydown"');
		expect(source).toContain(
			'const tabs = ["history", "partial", "drafts", "returns"]',
		);
		expect(source).toContain('event.key === "ArrowRight"');
		expect(source).toContain('event.key === "ArrowLeft"');
		expect(source).toContain('event.key === "Home"');
		expect(source).toContain('event.key === "End"');
		expect(source).toContain("event.stopImmediatePropagation?.();");
	});

	it("loads only the active tab while the dialog opens", () => {
		expect(source).toContain("this.suppressTabRefresh = true");
		expect(source).toContain("await this.loadSupervisorPosProfiles();");
		expect(source).toContain("await this.refreshActiveTab();");
		expect(source).toContain(
			"if (!this.suppressTabRefresh) this.refreshActiveTab();",
		);
		expect(source).not.toContain(
			"await Promise.all([this.loadUnpaidInvoices(), this.loadHistory(), this.loadDrafts()])",
		);
	});
});
