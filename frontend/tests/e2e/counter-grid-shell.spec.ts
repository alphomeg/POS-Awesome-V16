import { expect, test, type Page } from "@playwright/test";

import {
	cleanupProvisionedTerminalCashier,
	ensureAuthoritativeTerminalUnlock,
} from "./helpers/terminalAuth";

const ENABLED = process.env.POSA_COUNTER_GRID_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const KNOWN_ITEM_CODES = ["02017", "02016", "02249", "A3106", "22203"];

test.skip(
	!ENABLED,
	"Set POSA_COUNTER_GRID_E2E=1 to run Counter Grid E2E tests.",
);

test.afterEach(async ({ page }) => {
	await cleanupProvisionedTerminalCashier(page);
});

async function waitForPos(page: Page) {
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Counter Grid E2E requires POSA_SMOKE_SID or login credentials.",
		);
	}
	await ensureAuthoritativeTerminalUnlock(page);
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
}

async function waitForLoadingToSettle(page: Page) {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await expect(page.locator(".loading-overlay")).toHaveCount(0, {
			timeout: 90_000,
		});
		await page.waitForTimeout(750);
		if ((await page.locator(".loading-overlay").count()) === 0) return;
	}
	throw new Error("POS loading overlay did not remain settled.");
}

async function openCounterSearch(page: Page, query: string) {
	const entry = page.getByTestId("counter-grid-item-entry");
	await entry.fill(query);
	await entry.press("Enter");
	const search = page.getByTestId("pos-item-search").locator("input");
	await expect(search).toBeVisible({ timeout: 30_000 });
	await expect(search).toHaveValue(query);
	const selector = page.locator(".items-selector-shell--counter-dialog");
	await expect(selector).toHaveAttribute("data-search-ready-query", query, {
		timeout: 30_000,
	});
	return { entry, search, selector };
}

async function addKnownItemFromCounterSearch(
	page: Page,
	excludedCodes = new Set<string>(),
) {
	for (const itemCode of KNOWN_ITEM_CODES) {
		if (excludedCodes.has(itemCode)) continue;
		const { search } = await openCounterSearch(page, itemCode);
		const result = page.getByTestId(`pos-item-row-${itemCode}`);
		if (await result.isVisible({ timeout: 5_000 }).catch(() => false)) {
			await expect(result).toHaveAttribute("aria-selected", "true");
			await expect(search).toBeFocused();
			await search.press("Enter");
			const cartRow = page.getByTestId(`cart-row-${itemCode}`).first();
			await expect(cartRow).toBeVisible({ timeout: 30_000 });
			return { itemCode, cartRow };
		}
		await page.getByRole("button", { name: "Close item search" }).click();
		await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused();
	}
	throw new Error(
		`No searchable test item found from ${KNOWN_ITEM_CODES.join(", ")}.`,
	);
}

test.describe("Counter Grid shell", () => {
	test("uses Counter Grid at certified desktop widths and Classic below 1024px", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1366, height: 768 });
		await waitForPos(page);

		await expect(page.getByTestId("counter-grid-pos")).toBeVisible();
		await expect(page.getByTestId("counter-grid-item-entry")).toBeVisible();
		await expect(page.getByTestId("classic-invoice")).toHaveCount(0);

		await page.setViewportSize({ width: 1000, height: 768 });
		await expect(page.getByTestId("classic-invoice")).toHaveCount(1);
		await expect(page.getByTestId("counter-grid-pos")).toHaveCount(0);
		await expect(
			page.getByTestId("pos-item-search").locator("input"),
		).toBeVisible({
			timeout: 30_000,
		});
	});

	test("opens modal item search from the blank row and returns focus on close", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);

		const entry = page.getByTestId("counter-grid-item-entry");
		await expect(page.locator(".loading-overlay")).toHaveCount(0, {
			timeout: 90_000,
		});
		const { search } = await openCounterSearch(page, KNOWN_ITEM_CODES[0]);
		await expect(search).toBeFocused({ timeout: 10_000 });
		const pharmacyResults = page.getByTestId(
			"pharmacy-item-search-results",
		);
		await expect(pharmacyResults).toBeVisible();
		await expect(
			page.getByTestId("pharmacy-include-zero-stock"),
		).toBeVisible();
		const headings = await pharmacyResults
			.locator("thead th")
			.allTextContents();
		for (const heading of [
			"Code",
			"Product Name",
			"Pack",
			"Company",
			"Group",
			"Generic",
			"R.P",
			"Rack",
			"Pack Stock",
			"Loose",
		]) {
			expect(headings).toContain(heading);
		}

		await page.getByRole("button", { name: "Close item search" }).click();
		await expect(entry).toBeFocused({ timeout: 15_000 });
		await expect(entry).toHaveValue(KNOWN_ITEM_CODES[0]);
	});

	test("locks saved-draft keyboard navigation and restores item-entry focus", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);

		const entry = page.getByTestId("counter-grid-item-entry");
		await expect(entry).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("invoice-action-pay")).toBeFocused();
		await entry.focus();
		await addKnownItemFromCounterSearch(page);
		await entry.focus();
		await page.keyboard.press("Alt+l");

		const drawer = page.locator(".drafts-drawer");
		const cards = drawer.locator(".drafts-list__card");
		await expect(drawer).toBeVisible();
		await expect(
			drawer.locator('[data-test="drafts-retailmind-brand"]'),
		).toContainText("RetailMind-POS");
		await expect(cards.first()).toBeFocused({ timeout: 30_000 });
		await expect(cards.first()).toHaveAttribute("aria-current", "true");

		const cardCount = await cards.count();
		expect(cardCount).toBeGreaterThan(0);
		await page.keyboard.press("ArrowDown");
		const nextCard = cards.nth(cardCount > 1 ? 1 : 0);
		await expect(nextCard).toBeFocused();
		await expect(nextCard).toHaveClass(/drafts-list__card--selected/);
		await page.keyboard.press("ArrowUp");
		await expect(cards.first()).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(cards.first()).toBeFocused();

		await page.keyboard.press("ArrowLeft");
		await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/);
		await expect(entry).toBeFocused({ timeout: 15_000 });

		await page.keyboard.press("Alt+l");
		await expect(drawer).toHaveClass(/v-navigation-drawer--active/);
		await expect(cards.first()).toBeFocused({ timeout: 30_000 });
		await page.keyboard.press("Enter");
		await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/, {
			timeout: 30_000,
		});
		await expect(entry).toBeFocused({ timeout: 30_000 });
	});

	test("highlights only the active pharmacy search result", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);

		await openCounterSearch(page, "panadol");
		const rows = page.locator('[data-testid^="pos-item-row-"]');
		await expect(rows.nth(1)).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator(
				'[data-testid^="pos-item-row-"][aria-selected="true"]',
			),
		).toHaveCount(1);
		await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
		await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");
		await expect(rows.nth(1)).not.toHaveClass(/item-row-highlighted/);
	});

	test("advances through editable cells to the next item row and navigates back", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);
		const { cartRow } = await addKnownItemFromCounterSearch(page);

		const qtyInput = cartRow
			.locator('[data-column-key="qty"] input')
			.first();
		await expect(qtyInput).toBeFocused({ timeout: 15_000 });
		await qtyInput.fill("2");
		await page.keyboard.press("Enter");
		await expect(cartRow).toHaveAttribute(
			"data-active-cell-key",
			"discount_percentage",
		);
		await expect(
			cartRow.locator('[data-column-key="discount_percentage"] input'),
		).toBeFocused();

		await page.keyboard.press("Enter");
		await expect(cartRow).toHaveAttribute(
			"data-active-cell-key",
			"discount_amount",
		);
		await expect(
			cartRow.locator('[data-column-key="discount_amount"] input'),
		).toBeFocused();

		await page.keyboard.press("Enter");
		const entry = page.getByTestId("counter-grid-item-entry");
		await expect(entry).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("Shift+Tab");
		await expect(cartRow).toHaveAttribute(
			"data-active-cell-key",
			"discount_amount",
		);
		await expect(
			cartRow.locator('[data-column-key="discount_amount"] input'),
		).toBeFocused();

		await page.keyboard.press("Enter");
		await expect(entry).toBeFocused();
		await page.keyboard.press("ArrowUp");
		await expect(cartRow).toHaveAttribute(
			"data-active-cell-key",
			"item_name",
		);
		await expect(
			cartRow.locator('[data-column-key="item_name"]'),
		).toBeFocused();
	});

	test("moves from the final cart editor through item entry and every bottom action with arrows", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);
		const entry = page.getByTestId("counter-grid-item-entry");
		const actionIds = [
			"invoice-action-save-clear",
			"invoice-action-drafts",
			"invoice-action-management",
			"invoice-action-returns",
			"invoice-action-more",
			"invoice-action-cancel-sale",
			"invoice-action-pay",
		];

		await expect(entry).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("invoice-action-pay")).toBeFocused({
			timeout: 15_000,
		});
		await entry.focus();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByTestId("invoice-action-save-clear")).toBeFocused(
			{
				timeout: 15_000,
			},
		);
		await page.keyboard.press("ArrowUp");
		await expect(entry).toBeFocused({ timeout: 15_000 });

		const { cartRow } = await addKnownItemFromCounterSearch(page);
		const quantity = cartRow
			.locator('[data-column-key="qty"] input')
			.first();
		await expect(quantity).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("Shift+ArrowDown");
		await expect(quantity).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("ArrowDown");
		await expect(entry).toBeFocused({ timeout: 15_000 });

		await page.keyboard.press("ArrowDown");
		for (const [index, testId] of actionIds.entries()) {
			await expect(page.getByTestId(testId)).toBeFocused({
				timeout: 15_000,
			});
			if (index < actionIds.length - 1) {
				await page.keyboard.press("ArrowRight");
			}
		}

		for (let index = actionIds.length - 1; index > 0; index -= 1) {
			await page.keyboard.press("ArrowLeft");
			await expect(page.getByTestId(actionIds[index - 1])).toBeFocused({
				timeout: 15_000,
			});
		}

		await page.keyboard.press("ArrowUp");
		await expect(entry).toBeFocused({ timeout: 15_000 });
	});

	test("appends each distinct item below the prior row", async ({ page }) => {
		await page.setViewportSize({ width: 1366, height: 768 });
		await waitForPos(page);

		const first = await addKnownItemFromCounterSearch(page);
		await page.keyboard.press("F2");
		await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused();
		const second = await addKnownItemFromCounterSearch(
			page,
			new Set([first.itemCode]),
		);

		const codes = await page
			.locator(".posa-cart-item-row")
			.evaluateAll((rows) =>
				rows.map((row) =>
					(row.getAttribute("data-testid") || "").replace(
						"cart-row-",
						"",
					),
				),
			);
		expect(codes.slice(0, 2)).toEqual([first.itemCode, second.itemCode]);
	});

	test("supports spreadsheet boundary keys and reverse Enter progression", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1366, height: 768 });
		await waitForPos(page);
		const first = await addKnownItemFromCounterSearch(page);
		await page.keyboard.press("F2");
		const second = await addKnownItemFromCounterSearch(
			page,
			new Set([first.itemCode]),
		);

		const secondRow = page
			.getByTestId(`cart-row-${second.itemCode}`)
			.first();
		const secondQty = secondRow
			.locator('[data-column-key="qty"] input')
			.first();
		await expect(secondQty).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("End");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"data-table-expand",
		);
		await page.keyboard.press("Home");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"item_name",
		);

		await page.keyboard.press("Control+Home");
		const firstRow = page.getByTestId(`cart-row-${first.itemCode}`).first();
		await expect(firstRow).toHaveAttribute(
			"data-active-cell-key",
			"item_name",
		);
		await expect(firstRow.locator("td").first()).toHaveCSS(
			"background-color",
			"rgb(232, 243, 255)",
		);
		await expect(secondRow.locator("td").first()).toHaveCSS(
			"background-color",
			"rgb(255, 255, 255)",
		);
		await expect(firstRow).toHaveCSS("transition-duration", "0s");
		await expect(firstRow).toHaveCSS("animation-name", "none");
		await expect(firstRow.locator("td").first()).toHaveCSS(
			"transition-duration",
			"0s",
		);
		await page.keyboard.press("Control+End");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"data-table-expand",
		);

		await page.keyboard.press("Shift+Tab");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"actions",
		);
		await expect(
			secondRow.locator('[data-column-key="actions"] button'),
		).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"amount",
		);
		await expect(
			secondRow.locator('[data-column-key="amount"]'),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"actions",
		);
		await page.keyboard.press("Tab");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"data-table-expand",
		);
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(secondRow).toHaveAttribute(
			"data-active-cell-key",
			"discount_amount",
		);
		await expect(
			secondRow.locator('[data-column-key="discount_amount"] input'),
		).toBeFocused();

		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowRight");
		await expect(secondQty).toBeFocused({ timeout: 15_000 });
		await page.keyboard.press("Shift+Enter");
		const firstRowLastEditable = firstRow.locator(
			'[data-column-key="discount_amount"] input',
		);
		await expect(firstRowLastEditable).toBeFocused({ timeout: 15_000 });
	});

	test("retains cashier, sync, profile, PIN, and operational navigation", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);

		await page.getByRole("button", { name: "Open actions menu" }).click();
		for (const action of [
			"switch-cashier",
			"lock-screen",
			"sync-offline-sales",
			"close-shift",
		]) {
			await expect(
				page.locator(`[data-test="quick-action-${action}"]`),
			).toBeVisible();
		}
		await expect(page.locator(".menu-profile-card")).toContainText(
			"POS Awesome - MedPlus",
		);
		await page.keyboard.press("Escape");

		await page
			.getByRole("button", { name: "Toggle navigation drawer" })
			.click();
		const drawer = page.locator(".drawer-custom");
		await expect(drawer).toBeVisible();
		const routes = await drawer
			.locator(".drawer-item-title")
			.allTextContents();
		for (const route of [
			"POS",
			"Payments",
			"Purchase Order",
			"Barcode Printing",
		]) {
			expect(routes).toContain(route);
		}

		await drawer.locator('[data-test="drawer-footer-action"]').click();
		const settings = page.locator('[data-test="navbar-settings-panel"]');
		await expect(settings).toBeVisible();
		await expect(
			settings.locator(
				'[data-test="settings-panel-action-refresh-offline-data"]',
			),
		).toBeVisible();
		await expect(
			settings.locator(
				'[data-test="settings-panel-action-rebuild-offline-data"]',
			),
		).toBeVisible();
		await settings
			.locator('[data-test="settings-panel-category-personal"]')
			.click();
		const pinAction = settings.locator(
			'[data-test="settings-panel-action-manage-cashier-pin"]',
		);
		await expect(pinAction).toBeVisible();
		await pinAction.click();
		await expect(
			settings.locator('[data-test="settings-panel-detail-view"]'),
		).toContainText("Current PIN");
		await expect(
			settings.locator('[data-test="settings-panel-detail-view"]'),
		).toContainText("New PIN");
		await settings
			.locator('[data-test="navbar-settings-panel-close"]')
			.click();
		await expect(settings).toBeHidden();
	});

	test("opens offers and coupons from the Counter Grid command menu by keyboard", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await waitForPos(page);

		const moreActions = page.getByTestId("invoice-action-more");
		await moreActions.press("Enter");

		const offersAction = page.getByTestId("invoice-action-offers");
		await expect(offersAction).toBeVisible();
		await offersAction.press("Enter");
		await expect(page.getByTestId("counter-grid-offers")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("counter-grid-offers")).toBeHidden();
		await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused();

		await moreActions.press("Enter");
		const couponsAction = page.getByTestId("invoice-action-coupons");
		await expect(couponsAction).toBeVisible();
		await couponsAction.press("Enter");
		await expect(page.getByTestId("counter-grid-coupons")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("counter-grid-coupons")).toBeHidden();
		await expect(page.getByTestId("counter-grid-item-entry")).toBeFocused();
	});

	test("keeps the certified shell inside a 1024x768 viewport", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		await waitForPos(page);
		await expect(page.getByTestId("counter-grid-pos")).toBeVisible();
		await expect(page.getByTestId("counter-grid-summary")).toBeVisible();
		for (const testId of [
			"invoice-action-save-clear",
			"invoice-action-drafts",
			"invoice-action-management",
			"invoice-action-returns",
			"invoice-action-cancel-sale",
			"invoice-action-pay",
		]) {
			await expect(page.getByTestId(testId)).toBeVisible();
		}
		await waitForLoadingToSettle(page);
		await expect(
			page.locator(".v-snackbar").filter({ hasText: "Sell Offline" }),
		).toHaveCount(0);
		await page.screenshot({
			path: "test-results/counter-grid-1024x768.png",
			fullPage: true,
		});

		const overflow = await page.evaluate(() => ({
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: document.documentElement.clientWidth,
			documentHeight: document.documentElement.scrollHeight,
			viewportHeight: document.documentElement.clientHeight,
		}));
		expect(overflow.documentWidth).toBeLessThanOrEqual(
			overflow.viewportWidth + 1,
		);
		expect(overflow.documentHeight).toBeLessThanOrEqual(
			overflow.viewportHeight + 1,
		);
	});
});
