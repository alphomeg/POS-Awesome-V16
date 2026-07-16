import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(testsDir, "..");
const source = (...segments: string[]) =>
	readFileSync(path.join(frontendDir, "src", "posapp", ...segments), "utf8");

const relativeLuminance = (hex: string) => {
	const channels = hex
		.replace("#", "")
		.match(/.{2}/g)!
		.map((channel) => Number.parseInt(channel, 16) / 255)
		.map((channel) =>
			channel <= 0.04045
				? channel / 12.92
				: Math.pow((channel + 0.055) / 1.055, 2.4),
		);
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrastRatio = (foreground: string, background: string) => {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
};

describe("Counter Grid RetailMind Fresh Operations visual contract", () => {
	it("keeps every specified text pair at WCAG AA contrast", () => {
		for (const [foreground, background] of [
			["#ffffff", "#173b2b"],
			["#ffffff", "#087f7a"],
			["#ffffff", "#087443"],
			["#ffffff", "#c43d4d"],
			["#ffffff", "#1677d2"],
			["#172033", "#e9f6ef"],
			["#0b7044", "#dff1e7"],
			["#4338ca", "#eef2ff"],
			["#1268d5", "#e8f3ff"],
			["#8a4b00", "#fff1d6"],
			["#334155", "#e9eef3"],
		]) {
			expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrastRatio("#2563eb", "#ffffff")).toBeGreaterThanOrEqual(3);
	});

	it("uses the green-led brand palette, light data headers, and semantic actions", () => {
		const shell = source("components", "pos", "shell", "Pos.vue");
		const navbar = source("components", "navbar", "NavbarAppBar.vue");
		const tokens = source("styles", "counter-grid.css");
		const actions = source(
			"components",
			"pos",
			"invoice",
			"InvoiceActionButtons.vue",
		);
		const table = source(
			"components",
			"pos",
			"invoice",
			"items-table-styles.css",
		);

		expect(tokens).toContain("--rm-cg-forest-950: #173b2b");
		expect(tokens).toContain("--rm-cg-teal-700: #087f7a");
		expect(tokens).toContain("--rm-cg-surface-header: #e9f6ef");
		expect(tokens).toContain("--rm-cg-success: #087443");
		expect(tokens).toContain("--rm-cg-action-save-bg: #dff1e7");
		expect(tokens).toContain("--rm-cg-action-drafts-bg: #eef2ff");
		expect(tokens).toContain("--rm-cg-action-return-bg: #fff1d6");
		expect(tokens).toContain(
			"--counter-rugged-green: var(--rm-cg-success)",
		);
		expect(navbar).toContain("pos-navbar-enhanced--counter-grid");
		expect(navbar).toContain("background: var(--rm-cg-forest-950) !important");
		expect(navbar).toContain(
			"border-bottom: 2px solid var(--rm-cg-teal-300)",
		);
		expect(shell).toContain("border: 3px solid var(--counter-rugged-navy)");
		expect(table).toContain(
			"background: var(--rm-cg-surface-header) !important",
		);
		expect(table).toContain("color: var(--rm-cg-text) !important");
		expect(actions).toContain(
			"background: var(--counter-rugged-green) !important",
		);
		expect(actions).toContain(
			"background: var(--counter-rugged-red) !important",
		);
		expect(actions).toContain("counter-grid-action--save");
		expect(actions).toContain("counter-grid-action--drafts");
		expect(actions).toContain("counter-grid-action--invoices");
		expect(actions).toContain("counter-grid-action--return");
		expect(shell).toContain("background: var(--rm-cg-surface-canvas)");
		expect(shell).toContain("grid-template-rows: minmax(0, 1fr) 28px");
		expect(source("components", "pos", "Invoice.vue")).toContain(
			"flex: 1.35 1 560px",
		);
		expect(source("components", "pos", "Invoice.vue")).toContain(
			"display: contents",
		);
		expect(source("components", "pos", "Invoice.vue")).toContain(
			':show-search="false"',
		);
		expect(source("components", "pos", "Invoice.vue")).toContain(
			"invoice-items-heading",
		);
		expect(
			source("components", "pos", "invoice", "CounterGridEntryRow.vue"),
		).toContain("Scan or search item");
	});

	it("gives centered overlays and payment the same RetailMind presentation", () => {
		const shell = source("components", "pos", "shell", "Pos.vue");
		const tokens = source("styles", "counter-grid.css");

		expect(shell).toContain(
			"counter-grid-overlay-content counter-grid-search-content",
		);
		expect(shell).toContain(
			"counter-grid-overlay-content counter-grid-payment-content",
		);
		expect(shell).toContain("payment-shell--counter-grid");
		expect(shell).toContain('ref="paymentPanel"');
		expect(shell).toContain('@after-enter="handlePaymentDialogAfterEnter"');
		expect(shell).toContain(
			"paymentPanel.value?.stabilizePaymentKeyboardFocus?.()",
		);
		expect(tokens).toContain(
			".payment-shell--counter-grid .payment-section",
		);
		expect(tokens).toContain("border: 3px solid var(--rm-cg-forest-950)");
	});

	it("gives the invoice and pharmacy tables crisp cells and a saturated active row", () => {
		const table = source(
			"components",
			"pos",
			"invoice",
			"items-table-styles.css",
		);
		const pharmacy = source(
			"components",
			"pos",
			"items",
			"PharmacyItemSearchTable.vue",
		);
		const itemsTable = source(
			"components",
			"pos",
			"invoice",
			"ItemsTable.vue",
		);
		const cartRow = source(
			"components",
			"pos",
			"invoice",
			"CartItemRow.vue",
		);

		expect(table).toContain(
			"border-right: 1px solid var(--counter-rugged-soft-line)",
		);
		expect(table).toContain(
			"border-bottom: 1px solid var(--counter-rugged-line)",
		);
		expect(pharmacy).toContain(
			"background: var(--rm-cg-info) !important",
		);
		expect(pharmacy).toContain("color: #ffffff !important");
		expect(pharmacy).toContain(
			"tbody tr:nth-child(even):not(.item-row-highlighted)",
		);
		expect(pharmacy).not.toContain("row.scrollIntoView");
		expect(pharmacy).toContain("if (!activeRow && activeIndex >= 0)");
		expect(pharmacy).toContain("scroll-behavior: auto !important");
		expect(pharmacy).toContain("transition: none !important");
		expect(pharmacy).toContain("height: 40px !important");
		expect(table).not.toContain("tbody tr:nth-child(even)");
		expect(itemsTable).not.toContain("tbody tr:nth-child(even)");
		expect(table).toContain(
			"background: var(--rm-cg-surface-selected) !important",
		);
		expect(cartRow).toContain(
			"background: var(--rm-cg-surface-selected, #174a70) !important",
		);
		expect(cartRow).toContain("transition: none !important");
	});

	it("keeps the search header fixed while only the result viewport scrolls", () => {
		const selector = source(
			"components",
			"pos",
			"items",
			"ItemsSelector.vue",
		);
		expect(selector).toContain("overflow: hidden !important");
		expect(selector).toContain("min-height: 58px");
		expect(selector).toContain("pharmacyNavigationFrame");
		expect(selector).toContain("window.requestAnimationFrame(async () =>");
	});

	it("carries the same structural treatment into history and quick edit", () => {
		const history = source(
			"components",
			"pos",
			"invoice",
			"ItemSalesHistoryModal.vue",
		);
		const quickEdit = source(
			"components",
			"pos",
			"items",
			"ItemQuickEditDialog.vue",
		);

		for (const modal of [history, quickEdit]) {
			expect(modal).toContain("background: var(--rm-cg-teal-700)");
			expect(modal).toContain("background: var(--rm-cg-surface-canvas)");
			expect(modal).toContain("border-radius: 3px");
		}
		expect(history).toContain(".summary-tile");
		expect(quickEdit).toContain(".item-quick-edit__section-title");
	});
});
