// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const qzMock = vi.hoisted(() => {
	let websocketActive = false;

	const state = {
		posProfile: { value: null as Record<string, any> | null },
		isActive: vi.fn(() => websocketActive),
		connect: vi.fn(async () => {
			websocketActive = true;
		}),
		disconnect: vi.fn(async () => {
			websocketActive = false;
		}),
		setClosedCallbacks: vi.fn(),
		findPrinters: vi.fn(async () => [] as string[]),
		getDefaultPrinter: vi.fn(async () => ""),
		detailPrinters: vi.fn(async () => [] as Record<string, any>[]),
		setCertificatePromise: vi.fn(),
		setSignatureAlgorithm: vi.fn(),
		setSignaturePromise: vi.fn(),
		createConfig: vi.fn((printer: string, options: Record<string, any>) => ({
			printer,
			options,
		})),
		print: vi.fn(async () => undefined),
		setActive(value: boolean) {
			websocketActive = value;
		},
	};

	return state;
});

vi.mock("qz-tray", () => ({
	default: {
		websocket: {
			isActive: qzMock.isActive,
			connect: qzMock.connect,
			disconnect: qzMock.disconnect,
			setClosedCallbacks: qzMock.setClosedCallbacks,
		},
		printers: {
			find: qzMock.findPrinters,
			getDefault: qzMock.getDefaultPrinter,
			details: qzMock.detailPrinters,
		},
		security: {
			setCertificatePromise: qzMock.setCertificatePromise,
			setSignatureAlgorithm: qzMock.setSignatureAlgorithm,
			setSignaturePromise: qzMock.setSignaturePromise,
		},
		configs: {
			create: qzMock.createConfig,
		},
		print: qzMock.print,
	},
}));

vi.mock("../src/posapp/stores/uiStore", () => ({
	useUIStore: () => ({
		posProfile: qzMock.posProfile,
	}),
}));

describe("qzTray service", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		window.localStorage.clear();
		qzMock.setActive(false);
		qzMock.posProfile.value = null;
		qzMock.findPrinters.mockResolvedValue([]);
		qzMock.getDefaultPrinter.mockResolvedValue("");
		qzMock.detailPrinters.mockResolvedValue([]);
		(globalThis as any).frappe = {
			call: vi.fn(),
		};
	});

	it("keeps QZ disconnected until the user manually reconnects", async () => {
		const qzTray = await import("../src/posapp/services/qzTray");
		qzMock.setActive(true);

		await qzTray.disconnectQzTray();

		expect(qzMock.disconnect).toHaveBeenCalledTimes(1);

		const printersWhilePaused = await qzTray.findQzPrinters();

		expect(printersWhilePaused).toEqual([]);
		expect(qzMock.connect).not.toHaveBeenCalled();

		await expect(qzTray.printHtmlViaQz("<p>Receipt</p>")).rejects.toThrow(
			"manually disconnected",
		);
		expect(qzMock.connect).not.toHaveBeenCalled();

		qzMock.findPrinters.mockResolvedValue(["Receipt Printer"]);

		await expect(
			qzTray.connectQzTray({ userInitiated: true }),
		).resolves.toBe(true);

		expect(qzMock.connect).toHaveBeenCalledTimes(1);

		const printersAfterReconnect = await qzTray.findQzPrinters();

		expect(printersAfterReconnect).toEqual(["Receipt Printer"]);
	});

	it("uses the POS Profile default printer until this browser saves a manual override", async () => {
		qzMock.posProfile.value = {
			name: "Main POS",
			posa_qz_printer_name: "Profile Printer",
		};
		qzMock.setActive(true);
		qzMock.findPrinters.mockResolvedValue([
			"Profile Printer",
			"Counter Printer",
		]);

		const qzTray = await import("../src/posapp/services/qzTray");

		await qzTray.findQzPrinters();

		expect(qzTray.selectedQzPrinter.value).toBe("Profile Printer");
		expect(window.localStorage.getItem("posa_qz_printer_name:Main%20POS")).toBeNull();

		qzTray.setSelectedQzPrinter("Counter Printer");
		expect(window.localStorage.getItem("posa_qz_printer_name:Main%20POS")).toBe(
			"Counter Printer",
		);

		await qzTray.findQzPrinters();
		expect(qzTray.selectedQzPrinter.value).toBe("Counter Printer");

		qzTray.setSelectedQzPrinter("");
		expect(window.localStorage.getItem("posa_qz_printer_name:Main%20POS")).toBeNull();

		await qzTray.findQzPrinters();
		expect(qzTray.selectedQzPrinter.value).toBe("Profile Printer");
	});

	it("keeps browser printer choices scoped to the active POS Profile", async () => {
		qzMock.posProfile.value = { name: "Counter A" };
		const qzTray = await import("../src/posapp/services/qzTray");

		qzTray.setSelectedQzPrinter("Printer A");
		expect(qzTray.getSavedPrinterName()).toBe("Printer A");

		qzMock.posProfile.value = { name: "Counter B" };
		expect(qzTray.getSavedPrinterName()).toBe("");
		qzTray.setSelectedQzPrinter("Printer B");

		expect(window.localStorage.getItem("posa_qz_printer_name:Counter%20A")).toBe("Printer A");
		expect(window.localStorage.getItem("posa_qz_printer_name:Counter%20B")).toBe("Printer B");
	});

	it("recommends a physical thermal printer and excludes virtual queues", async () => {
		qzMock.posProfile.value = { name: "Main POS", posa_qz_printer_name: "" };
		qzMock.setActive(true);
		qzMock.findPrinters.mockResolvedValue([
			"Microsoft Print to PDF",
			"Front Counter Thermal 80mm",
			"Office Laser",
		]);
		qzMock.getDefaultPrinter.mockResolvedValue("Office Laser");
		qzMock.detailPrinters.mockResolvedValue([
			{ name: "Microsoft Print to PDF", physical: false, driver: "PDF" },
			{ name: "Front Counter Thermal 80mm", physical: true, driver: "Receipt" },
			{ name: "Office Laser", physical: true, driver: "PCL" },
		]);

		const qzTray = await import("../src/posapp/services/qzTray");
		const discovery = await qzTray.discoverQzPrinters();

		expect(discovery.recommendedPrinter).toBe("Front Counter Thermal 80mm");
		expect(discovery.recommendationReason).toBe("receipt");
		expect(discovery.ambiguous).toBe(false);
		expect(qzTray.selectedQzPrinter.value).toBe("Front Counter Thermal 80mm");
	});

	it("requires an explicit choice when several generic physical printers are equally plausible", async () => {
		qzMock.posProfile.value = { name: "Main POS" };
		qzMock.setActive(true);
		qzMock.findPrinters.mockResolvedValue(["Printer A", "Printer B"]);
		qzMock.detailPrinters.mockResolvedValue([
			{ name: "Printer A", physical: true },
			{ name: "Printer B", physical: true },
		]);

		const qzTray = await import("../src/posapp/services/qzTray");
		const discovery = await qzTray.discoverQzPrinters();

		expect(discovery.recommendedPrinter).toBe("");
		expect(discovery.ambiguous).toBe(true);
		expect(qzTray.selectedQzPrinter.value).toBe("");
	});

	it("prefers the POS Profile default over a transient selected printer", async () => {
		qzMock.posProfile.value = {
			posa_qz_printer_name: "Profile Printer",
		};
		qzMock.setActive(true);

		const qzTray = await import("../src/posapp/services/qzTray");

		qzTray.selectedQzPrinter.value = "Printer A";

		await qzTray.printHtmlViaQz("<p>Receipt</p>");

		expect(qzMock.createConfig).toHaveBeenCalledWith(
			"Profile Printer",
			expect.any(Object),
		);
	});

	it("falls back to the first discovered printer when no override or profile default exists", async () => {
		qzMock.setActive(true);
		qzMock.findPrinters.mockResolvedValue(["Printer A", "Printer B"]);

		const qzTray = await import("../src/posapp/services/qzTray");

		await qzTray.findQzPrinters();

		expect(qzTray.selectedQzPrinter.value).toBe("Printer A");
	});

	it("sends raw printer commands using QZ command format", async () => {
		qzMock.setActive(true);
		qzMock.findPrinters.mockResolvedValue(["Receipt Printer"]);

		const qzTray = await import("../src/posapp/services/qzTray");

		await qzTray.sendRawToQz("\x1B@Hello\n");

		expect(qzMock.print).toHaveBeenCalledWith(
			expect.objectContaining({ printer: "Receipt Printer" }),
			[
				{
					type: "raw",
					format: "command",
					flavor: "plain",
					data: "\x1B@Hello\n",
				},
			],
		);
	});

	it("prints an explicit 80 mm setup receipt to the selected queue", async () => {
		qzMock.setActive(true);
		const qzTray = await import("../src/posapp/services/qzTray");

		await qzTray.printQzSetupTestPage("Counter <One>");

		expect(qzMock.createConfig).toHaveBeenCalledWith(
			"Counter <One>",
			expect.objectContaining({
				size: { width: 80, height: null },
				units: "mm",
			}),
		);
		expect(qzMock.print).toHaveBeenCalledWith(
			expect.any(Object),
			[
				expect.objectContaining({
					type: "pixel",
					format: "html",
					data: expect.stringContaining("Counter &lt;One&gt;"),
				}),
			],
		);
	});
});
