import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("DefaultLayout bootstrap warning presentation", () => {
	it("routes bootstrap warnings through the navbar status indicator and a top-center snackbar", () => {
		const source = readFileSync(
			resolve(process.cwd(), "src/posapp/layouts/DefaultLayout.vue"),
			"utf8",
		);

		expect(source).toContain(
			':bootstrap-warning-active="visibleBootstrapWarningActive"',
		);
		expect(source).toContain(
			':bootstrap-warning-tooltip="visibleBootstrapWarningTooltip"',
		);
		expect(source).toContain(
			':bootstrap-capabilities="visibleBootstrapCapabilitySummaries"',
		);
		expect(source).toContain("shouldLiftBootstrapWarningStartupGate");
		expect(source).toContain("isOfflineSaleModeConfirmed");
		expect(source).toContain(
			"offlineSaleModeConfirmed: offlineSaleModeConfirmed.value",
		);
		expect(source).toContain("resolveOfflineQueueReadiness");
		expect(source).toContain("continuing the online POS bootstrap");
		expect(source).toContain("initialBootstrapSyncSettled");
		expect(source).toContain("const fastCounterStartupReady = computed");
		expect(source).toContain(
			"hotCatalogReady || (networkOnline.value && serverOnline.value)",
		);
		expect(source).toContain(
			"if (!fastCounterEnabled.value || manualOffline.value)",
		);
		expect(source).toContain("const itemsStartupReady = computed");
		expect(source).toMatch(
			/initialBootstrapSyncSettled\.value[\s\S]{0,220}loadingState\.sources\.init[\s\S]{0,700}markSourceLoaded\("init"\)/,
		);
		expect(source).toMatch(
			/loadingState\.sources\.items[\s\S]{0,220}markSourceLoaded\("items"\)/,
		);
		expect(source).toContain("const onlineCustomerStartupReady = computed");
		expect(source).toContain("const customersStartupReady = computed");
		expect(source).toMatch(
			/loadingState\.sources\.customers[\s\S]{0,240}markSourceLoaded\("customers"\)/,
		);
		expect(source).toMatch(
			/itemsStartupSyncSettled:\s*Boolean\(areItemsLoaded\)\s*&&\s*!areItemsSyncing/,
		);
		expect(source).toContain("<v-snackbar");
		expect(source).toContain('v-model="bootstrapSnackbarVisible"');
		expect(source).toContain('location="top center"');
		expect(source).toContain("Settings > Offline & Sync");
		expect(source).toContain(
			"Refresh Offline Data or Rebuild Offline Data",
		);
		expect(source).not.toContain("<v-alert");
	});
});
