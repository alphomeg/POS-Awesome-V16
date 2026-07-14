import { expect, test } from "@playwright/test";

const ENABLED = process.env.POSA_TERMINAL_SECURITY_E2E === "1";
const POS_PATH = process.env.POSA_SMOKE_PATH || "/desk/posapp";

test.skip(
	!ENABLED,
	"Set POSA_TERMINAL_SECURITY_E2E=1 to run terminal security E2E.",
);

test("authenticated POS session opens without the terminal lock gate", async ({
	page,
}) => {
	await page.goto(POS_PATH, { waitUntil: "domcontentloaded" });
	if (/\/login/.test(page.url())) {
		throw new Error(
			"Terminal security E2E requires POSA_SMOKE_SID or login credentials.",
		);
	}

	const lockDialog = page.locator('[data-test="terminal-lock-dialog"]');
	await expect(lockDialog).toBeHidden({ timeout: 90_000 });
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});

	const navbar = page.locator('[data-test="pos-navbar"]');
	await expect(navbar).toHaveAttribute("data-pos-profile", /\S+/, {
		timeout: 90_000,
	});
	const profileName = String(
		(await navbar.getAttribute("data-pos-profile")) || "",
	).trim();
	if (!profileName) {
		throw new Error(
			"POS opened without an active POS Profile.",
		);
	}

	const forgedCashier = "forged-local-cashier@example.invalid";
	await page.evaluate((cashier) => {
		localStorage.setItem("posa_terminal_cashier", cashier);
	}, forgedCashier);
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(lockDialog).toBeHidden({ timeout: 90_000 });
	await expect(page.locator(".main-section").first()).toBeVisible({
		timeout: 90_000,
	});
});
