// @vitest-environment jsdom

import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import QzTrayDialog from "../src/posapp/components/navbar/QzTrayDialog.vue";
import * as qzTrayService from "../src/posapp/services/qzTray";

const toastShow = vi.hoisted(() => vi.fn());
const uiStoreState = vi.hoisted(() => ({
	posProfile: {
		value: {
			name: "Main POS",
			posa_qz_printer_name: "",
		},
	},
	setPosProfile: vi.fn((profile: Record<string, any>) => {
		uiStoreState.posProfile.value = profile;
	}),
}));

vi.mock("../src/posapp/stores/toastStore", () => ({
	useToastStore: () => ({
		show: toastShow,
	}),
}));

vi.mock("../src/posapp/stores/uiStore", () => ({
	useUIStore: () => uiStoreState,
}));

vi.mock("../src/posapp/services/qzTray", async () => {
	const { ref } = await import("vue");
	const selectedQzPrinter = ref("Counter Printer");

	return {
		checkQzCertificateOnce: vi.fn(async () => undefined),
		connectQzTray: vi.fn(async () => true),
		disconnectQzTray: vi.fn(async () => undefined),
		discoverQzPrinters: vi.fn(async () => ({
			printers: ["Counter Printer"],
			details: [{ name: "Counter Printer", physical: true }],
			defaultPrinter: "Counter Printer",
			recommendedPrinter: "Counter Printer",
			recommendationReason: "default",
			ambiguous: false,
		})),
		getQzCertificateDownload: vi.fn(async () => ({ pem: "", company: "" })),
		getQzCertificateFilename: vi.fn(() => "qz.pem"),
		printQzSetupTestPage: vi.fn(async () => undefined),
		setupQzCertificate: vi.fn(async () => ({ status: "created" })),
		qzCertReady: ref(false),
		qzCertStatus: ref("trusted"),
		qzConnected: ref(true),
		qzConnecting: ref(false),
		qzPrinters: ref(["Counter Printer"]),
		qzReconnectPaused: ref(false),
		selectedQzPrinter,
		setSelectedQzPrinter: vi.fn((value: string) => {
			selectedQzPrinter.value = value;
		}),
	};
});

const BoxStub = defineComponent({
	setup(_, { slots }) {
		return () => h("div", {}, slots.default?.());
	},
});

const VDialogStub = defineComponent({
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
	},
	setup(_, { slots }) {
		return () => h("div", {}, slots.default?.());
	},
});

const VSelectStub = defineComponent({
	name: "VSelectStub",
	props: {
		modelValue: {
			type: String,
			default: "",
		},
	},
	emits: ["update:modelValue"],
	setup(props, { emit, attrs }) {
		return () =>
			h("input", {
				"data-test": attrs["data-test"],
				value: props.modelValue ?? "",
				onInput: (event: Event) =>
					emit("update:modelValue", (event.target as HTMLInputElement).value),
			});
	},
});

const VBtnStub = defineComponent({
	name: "VBtnStub",
	props: {
		disabled: {
			type: Boolean,
			default: false,
		},
	},
	emits: ["click"],
	setup(props, { slots, attrs, emit }) {
		return () =>
			h(
				"button",
				{
					type: "button",
					disabled: props.disabled,
					"data-test": attrs["data-test"],
					onClick: () => emit("click"),
				},
				slots.default?.(),
			);
	},
});

const globalComponents = {
	VDialog: VDialogStub,
	VCard: BoxStub,
	VCardTitle: BoxStub,
	VCardText: BoxStub,
	VCardActions: BoxStub,
	VSpacer: BoxStub,
	VAlert: BoxStub,
	VDivider: BoxStub,
	VIcon: BoxStub,
	VBtn: VBtnStub,
	VSelect: VSelectStub,
};

const mountDialog = () =>
	mount(QzTrayDialog, {
		props: {
			modelValue: true,
		},
		global: {
			components: globalComponents,
		},
	});

describe("QzTrayDialog", () => {
	beforeEach(() => {
		(globalThis as any).__ = (value: string) => value;
		toastShow.mockReset();
		uiStoreState.posProfile.value = {
			name: "Main POS",
			posa_qz_printer_name: "",
		};
		uiStoreState.setPosProfile.mockClear();
		qzTrayService.qzConnected.value = true;
		qzTrayService.qzConnecting.value = false;
		qzTrayService.qzCertStatus.value = "trusted";
		qzTrayService.qzReconnectPaused.value = false;
		qzTrayService.qzPrinters.value = ["Counter Printer"];
		qzTrayService.selectedQzPrinter.value = "Counter Printer";
		vi.mocked(qzTrayService.setSelectedQzPrinter).mockClear();
		(globalThis as any).frappe = {
			call: vi.fn(async () => ({
				message: {
					name: "Main POS",
					settings: {
						print_format: "RetailMind Thermal Receipt 80mm",
						print_receipt_on_order_complete: 1,
						posa_qz_printer_name: "Counter Printer",
						posa_silent_print: 1,
						posa_open_print_in_new_tab: 0,
						posa_raw_printing: 0,
						posa_raw_print_width: 42,
					},
				},
			})),
		};
		Object.assign(globalThis.navigator, {
			clipboard: {
				writeText: vi.fn(async () => undefined),
			},
		});
	});

	it("requires a confirmed test before enabling silent profile printing", async () => {
		const wrapper = mountDialog();
		await flushPromises();

		expect(wrapper.get('[data-test="qz-enable-silent-print"]').attributes("disabled")).toBeDefined();

		await wrapper.get('[data-test="qz-test-print"]').trigger("click");
		await flushPromises();
		expect(qzTrayService.printQzSetupTestPage).toHaveBeenCalledWith("Counter Printer");

		await wrapper.get('[data-test="qz-confirm-test-print"]').trigger("click");
		await flushPromises();
		expect(wrapper.get('[data-test="qz-enable-silent-print"]').attributes("disabled")).toBeUndefined();

		await wrapper.get('[data-test="qz-enable-silent-print"]').trigger("click");
		await flushPromises();

		expect((globalThis as any).frappe.call).toHaveBeenCalledWith({
			method: "posawesome.posawesome.api.qz.configure_pos_profile_silent_print",
			args: {
				pos_profile: "Main POS",
				printer_name: "Counter Printer",
				test_print_confirmed: 1,
			},
		});
		expect(uiStoreState.posProfile.value.posa_qz_printer_name).toBe("Counter Printer");
		expect(uiStoreState.posProfile.value.posa_silent_print).toBe(1);
		expect(uiStoreState.posProfile.value.posa_raw_printing).toBe(0);
		expect(toastShow).toHaveBeenCalledWith(
			expect.objectContaining({
				color: "success",
			}),
		);
	});
});
