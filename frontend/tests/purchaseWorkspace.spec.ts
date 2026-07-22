import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(testsDir, "..");
const source = (...segments: string[]) =>
	readFileSync(path.join(frontendDir, "src", "posapp", ...segments), "utf8");

describe("Purchasing workspace contract", () => {
	it("keeps purchasing separate from selling and saves drafts explicitly", () => {
		const workspace = source(
			"components",
			"pos",
			"purchase",
			"PurchaseOrders.vue",
		);

		expect(workspace).toContain('{{ __("Selling") }}');
		expect(workspace).toContain('{{ __("Purchasing") }}');
		expect(workspace).toContain("submit: 0");
		expect(workspace).toContain(
			"expected_modified: purchaseOrderModified.value",
		);
		expect(workspace).toContain(
			"purchaseItems.value[index].name = savedRow.name",
		);
		expect(workspace).toContain('__("Save Draft")');
		expect(workspace).not.toContain('__("PAY")');
		expect(workspace).toContain("get_purchase_entitlement");
		expect(workspace).toContain('__("Purchasing is read-only")');
		expect(workspace).not.toContain("itemsStore.updatePriceList");
		const selector = source(
			"components",
			"pos",
			"items",
			"ItemsSelector.vue",
		);
		expect(selector).toContain('props.context === "purchase"');
		expect(selector).toContain("scopedPriceList.value = priceList");
		const navbar = source("components", "Navbar.vue");
		expect(navbar).toContain("requiresPurchaseAccess");
		expect(navbar).toContain("posa_allow_purchase_order");
	});

	it("reserves ten dense rows and enables keyboard editing/navigation", () => {
		const table = source(
			"components",
			"pos",
			"purchase",
			"PurchaseItemsTable.vue",
		);
		const workspace = source(
			"components",
			"pos",
			"purchase",
			"PurchaseOrders.vue",
		);

		expect(table).toContain("VISIBLE_ROW_CAPACITY = 10");
		expect(table).toContain("VISIBLE_ROW_CAPACITY - this.items.length");
		expect(table).toContain('height="396"');
		expect(table).toContain("--purchase-grid-row-height: 36px");
		expect(table).toContain("moveFocusByArrow");
		expect(table).toContain('@keydown.esc.prevent="cancelQtyEdit(item)"');
		expect(table).toContain('@keydown.esc.prevent="cancelRateEdit(item)"');
		expect(workspace).toContain('event.key === "F2"');
		expect(workspace).toContain('event.key.toLowerCase() === "s"');
		expect(workspace).toContain("data-pos-keyboard-root");
		const supplierDialog = source(
			"components",
			"pos",
			"dialogs",
			"purchase",
			"SupplierDialog.vue",
		);
		expect(supplierDialog).toContain("handleDialogKeydown");
		expect(supplierDialog).toContain('event.key === "Escape"');
		expect(supplierDialog).toContain("focusFirstKeyboardTarget");
	});

	it("requires role and PIN authorization for every irreversible checkpoint", () => {
		const workspace = source(
			"components",
			"pos",
			"purchase",
			"PurchaseOrders.vue",
		);
		const management = source(
			"components",
			"pos",
			"purchase",
			"PurchaseManagementDialog.vue",
		);
		const authorization = source(
			"components",
			"pos",
			"purchase",
			"PurchaseAuthorizationDialog.vue",
		);
		const payment = source(
			"components",
			"pos",
			"purchase",
			"PurchasePaymentDialog.vue",
		);

		expect(workspace).toContain('action: "submit"');
		expect(workspace).toContain(
			":required-role=\"__('Purchase Manager')\"",
		);
		expect(management).toContain("authorization_pin: authorizationPin");
		expect(management).toContain('__("Stock Manager")');
		expect(management).toContain('__("Accounts Manager")');
		expect(management).toContain('__("Full pending quantities")');
		expect(management).not.toContain("updateActionQty");
		expect(authorization).toContain('type="password"');
		expect(authorization).toContain("data-pos-keyboard-root");
		expect(payment).toContain('value="drawer"');
		expect(payment).toContain('value="account"');
		expect(payment).toContain("payment_source: paymentSource.value");
	});
});
