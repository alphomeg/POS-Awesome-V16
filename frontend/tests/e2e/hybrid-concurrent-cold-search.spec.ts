import {
	expect,
	test,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";

const ENABLED = process.env.POSA_HYBRID_CONCURRENT_COLD_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";
const ITEM_CODE = process.env.POSA_HYBRID_VERIFIED_ITEM || "AI167";
const CONCURRENT_SIDS = parseConcurrentSessions(
	process.env.POSA_HYBRID_CONCURRENT_SIDS || "",
);
const CONCURRENT_SEARCH_BUDGET_MS = Number(
	process.env.POSA_HYBRID_CONCURRENT_SEARCH_BUDGET_MS || 8_000,
);

test.skip(
	!ENABLED,
	"Set POSA_HYBRID_CONCURRENT_COLD_E2E=1 and provide three unique session IDs.",
);

function parseConcurrentSessions(raw: string) {
	try {
		const sessions = JSON.parse(raw);
		if (
			Array.isArray(sessions) &&
			sessions.length >= 3 &&
			sessions
				.slice(0, 3)
				.every((session) => typeof session === "string" && session)
		) {
			return sessions.slice(0, 3) as string[];
		}
	} catch {
		// The explicit error below keeps malformed credentials out of test output.
	}
	return [];
}

function isMethodRequest(
	request: import("@playwright/test").Request,
	method: string,
) {
	return request.url().includes(method);
}

async function prepareColdTerminal(page: Page) {
	const hotCatalogueReady = page.waitForResponse(
		(response) =>
			isMethodRequest(response.request(), "get_hot_items") &&
			response.status() === 200,
		{ timeout: 3 * 60_000 },
	);
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Concurrent cold-search acceptance requires authenticated sessions.",
		);
	}
	await hotCatalogueReady;
	await expect(page.getByTestId("counter-grid-pos")).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.locator(".loading-overlay")).toHaveCount(0, {
		timeout: 90_000,
	});
}

async function runExactSearch(page: Page) {
	const entry = page.getByTestId("counter-grid-item-entry");
	await expect(entry).toBeFocused({ timeout: 30_000 });
	await entry.fill(ITEM_CODE);
	const startedAt = performance.now();
	await entry.press("Enter");
	const searchSurface = page.locator(".items-selector-shell--counter-dialog");
	await expect(
		searchSurface.locator(`[data-item-code="${ITEM_CODE}"]`).first(),
	).toBeVisible({ timeout: CONCURRENT_SEARCH_BUDGET_MS });
	await expect(searchSurface).toHaveAttribute(
		"data-search-ready-query",
		ITEM_CODE,
		{ timeout: CONCURRENT_SEARCH_BUDGET_MS },
	);
	return performance.now() - startedAt;
}

async function createAuthenticatedContext(browser: Browser, sid: string) {
	const baseUrl = process.env.POSA_SMOKE_BASE_URL || "http://127.0.0.1:8000";
	return browser.newContext({
		storageState: {
			cookies: [
				{
					name: "sid",
					value: sid,
					domain: new URL(baseUrl).hostname,
					path: "/",
					expires: -1,
					httpOnly: true,
					secure: baseUrl.startsWith("https://"),
					sameSite: "Lax",
				},
			],
			origins: [],
		},
	});
}

test("three independent cold terminals keep exact search within the concurrency budget", async ({
	browser,
}) => {
	test.setTimeout(8 * 60_000);
	if (CONCURRENT_SIDS.length !== 3 || new Set(CONCURRENT_SIDS).size !== 3) {
		throw new Error(
			"Provide exactly three distinct authenticated sessions.",
		);
	}

	const contexts: BrowserContext[] = [];
	try {
		for (const sid of CONCURRENT_SIDS) {
			contexts.push(await createAuthenticatedContext(browser, sid));
		}
		const pages = await Promise.all(
			contexts.map(async (context) => context.newPage()),
		);
		await Promise.all(pages.map((page) => prepareColdTerminal(page)));
		const latencies = await Promise.all(
			pages.map((page) => runExactSearch(page)),
		);
		for (const latency of latencies) {
			expect(latency).toBeLessThan(CONCURRENT_SEARCH_BUDGET_MS);
		}
		console.log(
			`[hybrid-concurrent-cold-search] latencies=${latencies
				.map((latency) => Math.round(latency))
				.join(",")}ms budget=${CONCURRENT_SEARCH_BUDGET_MS}ms`,
		);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});
