import { describe, expect, it, vi } from "vitest";

import {
	getPosServiceWorkerUrl,
	registerPosServiceWorker,
	shouldRegisterPosServiceWorker,
} from "../src/posapp/utils/serviceWorkerRegistration";

const localhost = { protocol: "http:", hostname: "127.0.0.1" } as Location;
const insecureRemoteHost = {
	protocol: "http:",
	hostname: "retailmind.local",
} as Location;
const secureRemoteHost = {
	protocol: "https:",
	hostname: "retailmind.example",
} as Location;

describe("POS service worker registration", () => {
	it("allows HTTPS and local development origins only when the API exists", () => {
		const serviceWorker = { register: vi.fn() } as ServiceWorkerContainer;

		expect(shouldRegisterPosServiceWorker(serviceWorker, localhost)).toBe(true);
		expect(
			shouldRegisterPosServiceWorker(serviceWorker, secureRemoteHost),
		).toBe(true);
		expect(
			shouldRegisterPosServiceWorker(serviceWorker, insecureRemoteHost),
		).toBe(false);
		expect(shouldRegisterPosServiceWorker(null, localhost)).toBe(false);
	});

	it("uses the build-versioned registration URL", () => {
		expect(getPosServiceWorkerUrl(" build-2000 ")).toBe(
			"/sw.js?v=build-2000",
		);
		expect(getPosServiceWorkerUrl(null)).toBe("/sw.js");
	});

	it("registers without waiting for an optional updater module", async () => {
		const registration = { scope: "https://pos.example.test/" } as ServiceWorkerRegistration;
		const serviceWorker = {
			register: vi.fn().mockResolvedValue(registration),
		} as unknown as ServiceWorkerContainer;
		const logger = { log: vi.fn(), error: vi.fn() };

		await expect(
			registerPosServiceWorker({
				buildVersion: "build-2000",
				serviceWorker,
				location: secureRemoteHost,
				logger,
			}),
		).resolves.toBe(registration);
		expect(serviceWorker.register).toHaveBeenCalledWith(
			"/sw.js?v=build-2000",
		);
		expect(logger.log).toHaveBeenCalledWith(
			"SW registered successfully",
			registration,
		);
	});
});
