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
			expect(
				contrastRatio(foreground, background),
			).toBeGreaterThanOrEqual(4.5);
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
		const header = source(
			"components",
			"pos",
			"invoice",
			"CounterGridTransactionHeader.vue",
		);
		const customer = source(
			"components",
			"pos",
			"customer",
			"Customer.vue",
		);
		const summary = source(
			"components",
			"pos",
			"invoice",
			"InvoiceSummary.vue",
		);

		expect(tokens).toContain("--rm-cg-forest-950: #173b2b");
		expect(tokens).toContain("--rm-cg-teal-700: #087f7a");
		expect(tokens).toContain("--rm-cg-surface-header: #e9f6ef");
		expect(tokens).toContain("--rm-cg-success: #087443");
		expect(tokens).toContain("--rm-cg-action-save-bg: #dff1e7");
		expect(tokens).toContain("--rm-cg-action-drafts-bg: #eef2ff");
		expect(tokens).toContain("--rm-cg-action-return-bg: #fff1d6");
		expect(tokens).toContain("--rm-cg-shell-navbar: #043228");
		expect(tokens).toContain("--rm-cg-shell-teal: #057876");
		expect(tokens).toContain("--rm-cg-shell-table-header: #ebf6f1");
		expect(tokens).toContain("--rm-cg-shell-pay: #036643");
		expect(tokens).toContain("--rm-cg-shell-cancel: #d44255");
		expect(tokens).toContain(
			".pos-main-container--counter-grid > .v-row.justify-center",
		);
		expect(tokens).toContain(
			"--counter-rugged-green: var(--rm-cg-success)",
		);
		expect(navbar).toContain("pos-navbar-enhanced--counter-grid");
		expect(navbar).toContain(
			"background: var(--rm-cg-shell-navbar) !important",
		);
		expect(navbar).toContain("isCounterGrid ? 74 : 56");
		expect(navbar).toContain(
			"border-bottom: 2px solid var(--rm-cg-teal-300)",
		);
		expect(shell).toContain("border: 3px solid var(--counter-rugged-navy)");
		expect(table).toContain(
			"background: var(--rm-cg-shell-table-header) !important",
		);
		expect(table).toContain("color: var(--rm-cg-text) !important");
		expect(actions).toContain(
			"background: var(--rm-cg-shell-pay) !important",
		);
		expect(actions).toContain(
			"background: var(--rm-cg-shell-cancel) !important",
		);
		expect(actions).toContain("counter-grid-action--save");
		expect(actions).toContain("counter-grid-action--drafts");
		expect(actions).toContain("counter-grid-action--invoices");
		expect(actions).toContain("counter-grid-action--return");
		expect(shell).toContain("background: var(--rm-cg-shell-canvas)");
		expect(shell).toContain("grid-template-rows: minmax(0, 1fr) 43px");
		expect(header).toContain("1.562fr 1.05fr 0.988fr 0.6fr 1.95fr");
		expect(header).toContain("padding-inline: 12px 10px");
		expect(header).toContain("height: 146px");
		expect(header).toContain("counter-grid-total-hero");
		expect(header).toContain("counter-grid-transaction-header--no-balance");
		expect(customer).toContain('presentation === "counter-grid-header"');
		expect(customer).toContain('data-testid="counter-grid-customer-add"');
		expect(customer).toContain('data-testid="counter-grid-customer-edit"');
		expect(customer).toContain(
			'data-testid="counter-grid-customer-reload"',
		);
		expect(summary).toContain("minmax(0, 2fr)");
		expect(summary).not.toContain("counter-grid-summary__metric--total");
		expect(source("components", "pos", "Invoice.vue")).toContain(
			':show-search="false"',
		);
		expect(source("components", "pos", "Invoice.vue")).toContain(
			"!isCounterGridPresentation",
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
		const invoiceManagement = source(
			"components",
			"pos",
			"flows",
			"InvoiceManagement.vue",
		);
		const itemsTable = source(
			"components",
			"pos",
			"invoice",
			"ItemsTable.vue",
		);

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
		expect(tokens).toContain(".counter-grid-legacy-safe-dialog");
		expect(tokens).toContain("backdrop-filter: none !important");
		for (const modal of [history, quickEdit, invoiceManagement]) {
			expect(modal).toContain(':transition="false"');
			expect(modal).toContain('class="counter-grid-legacy-safe-overlay"');
			expect(modal).toContain("counter-grid-legacy-safe-dialog");
		}
		expect(
			history.match(/class="counter-grid-legacy-safe-overlay"/g),
		).toHaveLength(2);
		expect(
			invoiceManagement.match(
				/class="counter-grid-legacy-safe-overlay"/g,
			),
		).toHaveLength(3);
		expect(
			quickEdit.match(/class="counter-grid-legacy-safe-overlay"/g),
		).toHaveLength(1);
		expect(tokens).toContain(
			".v-overlay.counter-grid-legacy-safe-overlay > .v-overlay__scrim",
		);
		expect(tokens).toContain(
			".v-overlay.counter-grid-legacy-safe-overlay > .counter-grid-legacy-safe-dialog",
		);
		expect(tokens).toContain("z-index: 0");
		expect(tokens).toContain("z-index: 1");
		expect(itemsTable).toContain("flushPendingHistoryEdit");
		expect(itemsTable).toContain(
			"window.setTimeout(flushPendingHistoryEdit, 0)",
		);
	});

	it("keeps modal keyboard targeting without turning the whole card into a ripple target", () => {
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
		const invoiceManagement = source(
			"components",
			"pos",
			"flows",
			"InvoiceManagement.vue",
		);

		expect(history).not.toContain('@click.capture="handleModalClick"');
		expect(quickEdit).not.toContain(
			'@click.capture="handleQuickEditClick"',
		);
		expect(invoiceManagement).not.toContain(
			'@click.capture="handleEditModalClick"',
		);
		expect(history).toContain(
			'addEventListener("click", handleModalClick, true)',
		);
		expect(quickEdit).toContain(
			'addEventListener("click", handleQuickEditClick, true)',
		);
		expect(invoiceManagement).toContain(
			'root.addEventListener("click", listener, true)',
		);
		expect(quickEdit).toContain(
			".posa-quick-edit-keyboard-box.v-input .v-field",
		);
		expect(quickEdit).not.toContain("box-shadow: 0 0 0 5px");
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
		expect(pharmacy).toContain("background: var(--rm-cg-info) !important");
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
