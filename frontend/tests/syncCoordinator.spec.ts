import { describe, expect, it, vi } from "vitest";
import { SyncCoordinator } from "../src/offline/sync/SyncCoordinator";
import {
	resetSyncCoordinatorForTests,
	setSyncCoordinator,
	useSyncCoordinator,
} from "../src/offline/sync/useSyncCoordinator";
import type {
	SyncResourceDefinition,
	SyncTrigger,
} from "../src/offline/sync/types";

vi.mock("../src/offline/sync/syncState", () => ({
	setSyncResourceState: vi.fn(async () => undefined),
}));

const makeResource = (
	id: SyncResourceDefinition["id"],
	priority: SyncResourceDefinition["priority"],
	triggers: SyncTrigger[],
): SyncResourceDefinition => ({
	id,
	scope: "profile",
	mode: "delta",
	priority,
	triggers,
	storageKey: `${id}_cache`,
	watermarkType: "timestamp",
	fullResyncSupported: true,
});

describe("SyncCoordinator", () => {
	it("dedupes concurrent runs for the same trigger", async () => {
		const resources = [
			makeResource("bootstrap_config", "boot_critical", ["boot"]),
			makeResource("price_list_meta", "boot_critical", ["boot"]),
		];
		const runResource = vi.fn(async () => undefined);
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources,
			runResource,
		});

		await Promise.all([
			coordinator.runTrigger("boot"),
			coordinator.runTrigger("boot"),
		]);

		expect(runResource).toHaveBeenCalledTimes(2);
		expect(runResource.mock.calls.map(([resource]) => resource.id)).toEqual(
			["bootstrap_config", "price_list_meta"],
		);
	});

	it("runs resources in priority order for a trigger", async () => {
		const resources = [
			makeResource("items", "warm", ["online_resume"]),
			makeResource("invoice_outbox", "transactional", ["online_resume"]),
			makeResource("bootstrap_config", "boot_critical", [
				"online_resume",
			]),
			makeResource("customers", "warm", ["online_resume"]),
			makeResource("price_list_meta", "boot_critical", ["online_resume"]),
		];
		const started: string[] = [];
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources,
			runResource: async (resource) => {
				started.push(resource.id);
			},
		});

		await coordinator.runTrigger("online_resume");

		expect(started).toEqual([
			"invoice_outbox",
			"bootstrap_config",
			"price_list_meta",
			"items",
			"customers",
		]);
	});

	it("serializes distinct overlapping triggers without dropping any", async () => {
		let releaseRun: (() => void) | null = null;
		let activeRuns = 0;
		let maxActiveRuns = 0;
		const started: SyncTrigger[] = [];
		const runResource = vi.fn(async (_resource, trigger: SyncTrigger) => {
			started.push(trigger);
			activeRuns += 1;
			maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
			if (trigger === "online_resume") {
				await new Promise<void>((resolve) => {
					releaseRun = resolve;
				});
			}
			activeRuns -= 1;
		});
		const coordinator = new SyncCoordinator({
			resources: [
				makeResource("invoice_outbox", "transactional", [
					"online_resume",
					"timer",
					"user_action",
				]),
			],
			runResource,
		});

		const reconnect = coordinator.runTrigger("online_resume");
		const timer = coordinator.runTrigger("timer");
		const manual = coordinator.runTrigger("user_action");

		expect(timer).toBe(reconnect);
		expect(manual).toBe(reconnect);
		await vi.waitFor(() => expect(runResource).toHaveBeenCalledTimes(1));
		releaseRun?.();
		await reconnect;

		expect(started[0]).toBe("online_resume");
		expect(started).toContain("timer");
		expect(started).toContain("user_action");
		expect(maxActiveRuns).toBe(1);
	});

	it("starts urgent transactional work before an active catalog resource finishes", async () => {
		let releaseItems: (() => void) | null = null;
		const started: string[] = [];
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources: [
				makeResource("invoice_outbox", "transactional", [
					"online_resume",
					"user_action",
				]),
				makeResource("items", "warm", ["online_resume"]),
			],
			runResource: async (resource, trigger) => {
				started.push(`${trigger}:${resource.id}`);
				if (resource.id === "items") {
					await new Promise<void>((resolve) => {
						releaseItems = resolve;
					});
				}
			},
		});

		const catalogRun = coordinator.runTrigger("online_resume");
		await vi.waitFor(() =>
			expect(started).toEqual([
				"online_resume:invoice_outbox",
				"online_resume:items",
			]),
		);

		const overlappingSignal = coordinator.runTrigger("user_action");
		await vi.waitFor(() =>
			expect(started).toContain("user_action:invoice_outbox"),
		);
		expect(started.indexOf("user_action:invoice_outbox")).toBeGreaterThan(
			started.indexOf("online_resume:items"),
		);

		releaseItems?.();
		await Promise.all([catalogRun, overlappingSignal]);
	});

	it("allows payment recovery to await only the transactional lane", async () => {
		let releaseItems: (() => void) | null = null;
		const started: string[] = [];
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources: [
				makeResource("invoice_outbox", "transactional", [
					"online_resume",
					"user_action",
				]),
				makeResource("items", "warm", ["online_resume"]),
			],
			runResource: async (resource, trigger) => {
				started.push(`${trigger}:${resource.id}`);
				if (resource.id === "items") {
					await new Promise<void>((resolve) => {
						releaseItems = resolve;
					});
				}
			},
		});

		const catalogRun = coordinator.runTrigger("online_resume");
		await vi.waitFor(() =>
			expect(started).toContain("online_resume:items"),
		);

		await expect(
			coordinator.runTransactionalTrigger("user_action"),
		).resolves.toBeUndefined();
		expect(started).toContain("user_action:invoice_outbox");

		releaseItems?.();
		await catalogRun;
	});

	it("awaits legacy recovery after the outbox and before catalog sync", async () => {
		const order: string[] = [];
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources: [
				makeResource("items", "warm", ["online_resume"]),
				makeResource("invoice_outbox", "transactional", [
					"online_resume",
				]),
			],
			runResource: async (resource) => {
				order.push(resource.id);
			},
			onPriorityComplete: async (priority) => {
				if (priority === "transactional") {
					await Promise.resolve();
					order.push("legacy_invoice_queue");
				}
			},
		});

		await coordinator.runTrigger("online_resume");

		expect(order).toEqual([
			"invoice_outbox",
			"legacy_invoice_queue",
			"items",
		]);
	});

	it("uses the configured coordinator instead of creating an inert instance", () => {
		resetSyncCoordinatorForTests();
		expect(() => useSyncCoordinator()).toThrow("has not been configured");

		const coordinator = new SyncCoordinator({ resources: [] });
		expect(setSyncCoordinator(coordinator)).toBe(coordinator);
		expect(useSyncCoordinator()).toBe(coordinator);
		resetSyncCoordinatorForTests();
	});

	it("never exceeds configured concurrency while a trigger is running", async () => {
		const resources = [
			makeResource("bootstrap_config", "boot_critical", [
				"online_resume",
			]),
			makeResource("price_list_meta", "boot_critical", ["online_resume"]),
			makeResource("currency_matrix", "boot_critical", ["online_resume"]),
			makeResource("payment_method_currencies", "boot_critical", [
				"online_resume",
			]),
		];
		let activeRuns = 0;
		let maxActiveRuns = 0;
		const coordinator = new SyncCoordinator({
			concurrency: 2,
			resources,
			runResource: async () => {
				activeRuns += 1;
				maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
				await new Promise((resolve) => setTimeout(resolve, 5));
				activeRuns -= 1;
			},
		});

		await coordinator.runTrigger("online_resume");

		expect(maxActiveRuns).toBeLessThanOrEqual(2);
		expect(coordinator.getResourceState("bootstrap_config")?.status).toBe(
			"fresh",
		);
	});

	it("continues warm resources after a non-critical failure and records a summary", async () => {
		const resources = [
			makeResource("items", "warm", ["online_resume"]),
			makeResource("customers", "warm", ["online_resume"]),
		];
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources,
			runResource: async (resource) => {
				if (resource.id === "items") {
					throw new Error("items failed");
				}
				return undefined;
			},
		});

		await expect(
			coordinator.runTrigger("online_resume"),
		).resolves.toBeUndefined();

		expect(coordinator.getResourceState("items")?.status).toBe("error");
		expect(coordinator.getResourceState("customers")?.status).toBe("fresh");
		expect(coordinator.getLastRunSummary()).toMatchObject({
			trigger: "online_resume",
			failed: 1,
			succeeded: 1,
			bootCriticalFailures: 0,
			errors: [
				expect.objectContaining({
					resourceId: "items",
					message: "items failed",
				}),
			],
		});
	});

	it("completes all boot-critical resources before throwing and skips lower priorities", async () => {
		const resources = [
			makeResource("bootstrap_config", "boot_critical", ["boot"]),
			makeResource("price_list_meta", "boot_critical", ["boot"]),
			makeResource("items", "warm", ["boot"]),
		];
		const started: string[] = [];
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources,
			runResource: async (resource) => {
				started.push(resource.id);
				if (resource.id === "bootstrap_config") {
					throw new Error("bootstrap failed");
				}
				return undefined;
			},
		});

		await expect(coordinator.runTrigger("boot")).rejects.toThrow(
			"Boot-critical offline sync failed",
		);

		expect(started).toEqual(["bootstrap_config", "price_list_meta"]);
		expect(coordinator.getLastRunSummary()).toMatchObject({
			bootCriticalFailures: 1,
			failed: 1,
			succeeded: 1,
		});
	});

	it("defers retries during cooldown while keeping usable stale state", async () => {
		const resource = makeResource("items", "warm", [
			"timer",
			"user_action",
		]);
		const runResource = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary failure"))
			.mockResolvedValueOnce(undefined);
		const coordinator = new SyncCoordinator({
			concurrency: 1,
			resources: [resource],
			runResource,
			initialBackoffMs: 60_000,
			maxBackoffMs: 60_000,
		});

		coordinator.hydrateResourceStates([
			{
				resourceId: "items",
				status: "fresh",
				lastSyncedAt: "2026-04-18T10:00:00.000Z",
				watermark: "wm-1",
				lastSuccessHash: null,
				lastError: null,
				consecutiveFailures: 0,
				lastAttemptAt: null,
				nextRetryAt: null,
				cooldownMs: null,
				lastTrigger: null,
				scopeSignature: "profile:main",
				schemaVersion: "1",
			},
		]);

		await expect(coordinator.runTrigger("timer")).resolves.toBeUndefined();
		expect(runResource).toHaveBeenCalledTimes(1);

		await expect(coordinator.runTrigger("timer")).resolves.toBeUndefined();
		expect(runResource).toHaveBeenCalledTimes(1);
		expect(coordinator.getResourceState("items")).toMatchObject({
			status: "stale",
			consecutiveFailures: 1,
		});

		await expect(
			coordinator.runTrigger("user_action"),
		).resolves.toBeUndefined();
		expect(runResource).toHaveBeenCalledTimes(2);
		expect(coordinator.getResourceState("items")?.status).toBe("fresh");
	});

	it("preserves adapter retry timing in coordinator state", async () => {
		const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
		const coordinator = new SyncCoordinator({
			resources: [
				makeResource("invoice_outbox", "transactional", ["timer"]),
			],
			runResource: async () => ({
				status: "stale",
				nextRetryAt,
				lastError: "waiting for retry",
			}),
		});

		await coordinator.runTrigger("timer");

		expect(coordinator.getResourceState("invoice_outbox")).toMatchObject({
			status: "stale",
			nextRetryAt,
			lastError: "waiting for retry",
		});
		expect(
			coordinator.getResourceState("invoice_outbox")?.cooldownMs,
		).toBeGreaterThan(0);
	});
});
