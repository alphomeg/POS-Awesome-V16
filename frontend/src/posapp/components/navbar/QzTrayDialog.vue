<template>
	<v-dialog v-model="dialogModel" max-width="760">
		<v-card class="qz-dialog-card">
			<v-card-title class="d-flex align-center">
				<v-icon start color="primary">mdi-printer-wireless</v-icon>
				{{ __("QZ Tray Setup") }}
			</v-card-title>

			<v-card-text>
				<v-alert
					class="mb-4"
					:type="qzConnecting ? 'warning' : qzConnected ? 'success' : 'error'"
					variant="tonal"
					density="comfortable"
				>
					{{ connectionStatusText }}
				</v-alert>

				<div class="d-flex flex-wrap ga-2 mb-4">
					<v-btn
						color="primary"
						:loading="qzConnecting"
						:disabled="qzConnected && !qzConnecting"
						@click="handleConnect"
					>
						{{ __("Connect") }}
					</v-btn>
					<v-btn
						color="secondary"
						variant="outlined"
						:loading="loadingPrinters"
						:disabled="loadingPrinters || (qzReconnectPaused && !qzConnected)"
						@click="refreshPrinters"
					>
						{{ __("Refresh Printers") }}
					</v-btn>
					<v-btn color="default" variant="text" :disabled="!qzConnected" @click="handleDisconnect">
						{{ __("Disconnect") }}
					</v-btn>
				</div>

				<v-select
					v-model="selectedPrinter"
					:items="printerOptions"
					:label="__('Printer')"
					:placeholder="__('Select printer')"
					data-test="qz-printer-select"
					variant="outlined"
					density="compact"
					clearable
					:disabled="loadingPrinters"
				/>

				<v-alert
					v-if="recommendationText"
					type="info"
					variant="tonal"
					density="compact"
					class="mt-3"
					data-test="qz-printer-recommendation"
				>
					{{ recommendationText }}
				</v-alert>

				<v-alert
					v-if="discoveryAmbiguous"
					type="warning"
					variant="tonal"
					density="compact"
					class="mt-3"
				>
					{{ __("Multiple possible printers were found. Select the receipt printer explicitly.") }}
				</v-alert>

				<div class="d-flex flex-wrap ga-2 mt-3">
					<v-btn
						data-test="qz-test-print"
						color="secondary"
						variant="tonal"
						:loading="testingPrinter"
						:disabled="!selectedPrinter || !qzConnected || testingPrinter"
						@click="handleTestPrint"
					>
						{{ __("Print 80 mm Test") }}
					</v-btn>
				</div>

				<v-alert
					v-if="!selectedPrinter"
					type="warning"
					variant="tonal"
					density="compact"
					class="mt-3"
				>
					{{ __("Select a printer to use QZ silent printing.") }}
				</v-alert>

				<v-alert
					v-if="testPrintSent"
					type="warning"
					variant="tonal"
					density="comfortable"
					class="mt-3"
					data-test="qz-test-confirmation"
				>
					<div>
						{{
							__(
								"Confirm that the test printed from the correct printer, fits the roll, and showed no Chrome or QZ prompt.",
							)
						}}
					</div>
					<v-btn
						class="mt-2"
						data-test="qz-confirm-test-print"
						color="success"
						variant="tonal"
						@click="handleConfirmTestPrint"
					>
						{{ __("Test Printed Correctly") }}
					</v-btn>
				</v-alert>

				<v-alert
					v-if="testPrintConfirmed"
					type="success"
					variant="tonal"
					density="compact"
					class="mt-3"
				>
					{{ __("Printer test confirmed. Silent HTML printing can now be enabled.") }}
				</v-alert>

				<div class="d-flex flex-wrap align-center justify-space-between ga-2 mt-3">
					<div class="text-caption text-medium-emphasis">
						{{
							__(
								"This saves the queue on the active POS Profile, selects the 80 mm receipt format, and keeps raw printing disabled.",
							)
						}}
					</div>
					<v-btn
						data-test="qz-enable-silent-print"
						color="primary"
						:loading="savingProfilePrinter"
						:disabled="!canConfigureSilentPrint"
						@click="handleConfigureSilentPrint"
					>
						{{ __("Enable Silent Printing") }}
					</v-btn>
				</div>

				<v-divider class="my-4"></v-divider>

				<div class="text-subtitle-1 mb-2">{{ __("Certificate") }}</div>
				<v-alert :type="certAlertType" variant="tonal" density="comfortable" class="mb-3">
					{{ certificateStatusText }}
				</v-alert>

				<div class="d-flex flex-wrap ga-2">
					<v-btn color="warning" :loading="certificateLoading" @click="handleGenerateCertificate">
						{{ __("Generate Certificate") }}
					</v-btn>
					<v-btn
						color="info"
						variant="outlined"
						:disabled="!qzCertReady"
						@click="handleDownloadCertificate"
					>
						{{ __("Download Certificate") }}
					</v-btn>
				</div>

				<div class="text-caption mt-3">
					{{ __("Import the certificate into QZ Tray and restart QZ Tray on each POS machine.") }}
				</div>
			</v-card-text>

			<v-card-actions>
				<v-spacer />
				<v-btn variant="text" @click="dialogModel = false">{{ __("Close") }}</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";
import {
	checkQzCertificateOnce,
	connectQzTray,
	disconnectQzTray,
	discoverQzPrinters,
	getQzCertificateDownload,
	getQzCertificateFilename,
	qzCertReady,
	qzCertStatus,
	qzConnected,
	qzConnecting,
	qzPrinters,
	qzReconnectPaused,
	printQzSetupTestPage,
	selectedQzPrinter,
	setSelectedQzPrinter,
	setupQzCertificate,
	type QzCertStatus,
	type QzPrinterDiscoveryResult,
} from "../../services/qzTray";

const props = defineProps<{
	modelValue: boolean;
}>();

const emit = defineEmits<{
	(e: "update:modelValue", value: boolean): void;
}>();

const toastStore = useToastStore();
const uiStore = useUIStore();
const loadingPrinters = ref(false);
const certificateLoading = ref(false);
const savingProfilePrinter = ref(false);
const testingPrinter = ref(false);
const testPrintSent = ref(false);
const testPrintConfirmed = ref(false);
const discovery = ref<QzPrinterDiscoveryResult | null>(null);

const dialogModel = computed({
	get: () => props.modelValue,
	set: (value: boolean) => emit("update:modelValue", value),
});

const selectedPrinter = computed({
	get: () => selectedQzPrinter.value || null,
	set: (value: string | null) => {
		setSelectedQzPrinter(value || "");
		resetTestConfirmation();
	},
});

const printerOptions = computed(() =>
	qzPrinters.value.map((printer) => ({
		title: printer,
		value: printer,
	})),
);

const currentProfile = computed(() => {
	const profile =
		uiStore?.posProfile && typeof uiStore.posProfile === "object" && "value" in uiStore.posProfile
			? uiStore.posProfile.value
			: uiStore?.posProfile;

	return profile && typeof profile === "object" ? profile : null;
});

const profileName = computed(() => {
	const name = currentProfile.value?.name;
	return typeof name === "string" ? name.trim() : "";
});

const discoveryAmbiguous = computed(() => Boolean(discovery.value?.ambiguous));

const recommendationText = computed(() => {
	const printer = discovery.value?.recommendedPrinter;
	if (!printer) return "";
	const reason = discovery.value?.recommendationReason;
	if (reason === "configured")
		return __("Using the printer already configured on this POS Profile: {0}", [printer]);
	if (reason === "terminal") return __("Using this terminal's saved printer: {0}", [printer]);
	if (reason === "receipt") return __("Recommended thermal/receipt printer: {0}", [printer]);
	if (reason === "default") return __("Recommended operating-system default printer: {0}", [printer]);
	return __("Only physical printer detected: {0}", [printer]);
});

const canConfigureSilentPrint = computed(
	() =>
		Boolean(selectedPrinter.value) &&
		Boolean(profileName.value) &&
		testPrintConfirmed.value &&
		qzConnected.value &&
		qzCertStatus.value === "trusted",
);

const certAlertType = computed(() => {
	if (qzCertStatus.value === "trusted") return "success";
	if (qzCertStatus.value === "untrusted") return "error";
	return "warning";
});

const connectionStatusText = computed(() => {
	if (qzConnecting.value) {
		return __("Connecting to QZ Tray...");
	}
	if (qzConnected.value) {
		return __("QZ Tray connected.");
	}
	if (qzReconnectPaused.value) {
		return __("QZ Tray is manually disconnected. Press Connect to enable it again.");
	}
	return __("QZ Tray is not connected.");
});

const certificateStatusText = computed(() => {
	const status = qzCertStatus.value as QzCertStatus;
	if (status === "trusted") {
		return __("Certificate is trusted. Silent QZ printing is active.");
	}
	if (status === "untrusted") {
		return __("Certificate is missing or not trusted. QZ may show confirmation dialogs.");
	}
	return __("Generate and install the certificate to allow fully silent printing without trust prompts.");
});

function __(text: string, args?: string[]) {
	if (typeof window !== "undefined" && typeof (window as any).__ === "function") {
		return (window as any).__(text, args);
	}
	return text;
}

function notify(title: string, color = "info") {
	toastStore.show({ title: __(title), color });
}

function resetTestConfirmation() {
	testPrintSent.value = false;
	testPrintConfirmed.value = false;
}

async function handleConnect(showNotification = true) {
	try {
		const connected = await connectQzTray({ userInitiated: true });
		if (!connected) {
			if (showNotification) {
				notify("Could not connect to QZ Tray.", "warning");
			}
			return;
		}
		await refreshPrinters(false);
	} catch (error: any) {
		console.error("Failed to connect to QZ Tray", error);
		if (showNotification) {
			notify(
				error?.message
					? `Could not connect to QZ Tray. ${error.message}`
					: "Could not connect to QZ Tray.",
				"warning",
			);
		}
		return;
	}
	if (showNotification) {
		notify("Connected to QZ Tray.", "success");
	}
}

async function handleDisconnect() {
	await disconnectQzTray();
	notify("QZ Tray disconnected. Auto-connect is paused until you press Connect.", "info");
}

async function refreshPrinters(showNotification = true) {
	if (qzReconnectPaused.value && !qzConnected.value) {
		if (showNotification) {
			notify("QZ Tray is manually disconnected. Press Connect to enable it again.", "warning");
		}
		return;
	}

	loadingPrinters.value = true;
	try {
		discovery.value = await discoverQzPrinters();
		const printers = discovery.value.printers;
		resetTestConfirmation();
		if (showNotification) {
			if (printers.length) {
				notify("Printer list updated.", "success");
			} else {
				notify("No printers found. Make sure QZ Tray is running.", "warning");
			}
		}
	} catch (error: any) {
		console.error("Failed to discover QZ printers", error);
		notify(
			error?.message
				? `Failed to discover printers. Check QZ Tray. ${error.message}`
				: "Failed to discover printers. Check QZ Tray.",
			"warning",
		);
	} finally {
		loadingPrinters.value = false;
	}
}

async function handleTestPrint() {
	if (!selectedPrinter.value) {
		notify("Select a printer before printing the test receipt.", "warning");
		return;
	}
	testingPrinter.value = true;
	try {
		await printQzSetupTestPage(selectedPrinter.value);
		testPrintSent.value = true;
		testPrintConfirmed.value = false;
		notify("80 mm test receipt sent. Confirm the physical result below.", "success");
	} catch (error: any) {
		console.error("Failed to print QZ setup test", error);
		resetTestConfirmation();
		notify(error?.message || "Failed to print the 80 mm test receipt.", "error");
	} finally {
		testingPrinter.value = false;
	}
}

function handleConfirmTestPrint() {
	testPrintConfirmed.value = true;
	notify("Printer test confirmed.", "success");
}

async function handleConfigureSilentPrint() {
	if (!selectedPrinter.value) {
		notify("Select a printer before enabling silent printing.", "warning");
		return;
	}
	if (!profileName.value) {
		notify("POS Profile is not loaded yet. Try again in a moment.", "warning");
		return;
	}
	if (!testPrintConfirmed.value) {
		notify("Print and confirm the 80 mm test receipt first.", "warning");
		return;
	}
	if (qzCertStatus.value !== "trusted") {
		notify("Trust the RetailMind certificate in QZ Tray, reconnect, and repeat the test.", "warning");
		return;
	}

	try {
		savingProfilePrinter.value = true;
		const response = await frappe.call({
			method: "posawesome.posawesome.api.qz.configure_pos_profile_silent_print",
			args: {
				pos_profile: profileName.value,
				printer_name: selectedPrinter.value,
				test_print_confirmed: 1,
			},
		});
		const settings = response?.message?.settings || {};
		const updatedProfile = {
			...(currentProfile.value || {}),
			...(settings && typeof settings === "object" ? settings : {}),
		};
		if (typeof uiStore?.setPosProfile === "function") {
			uiStore.setPosProfile(updatedProfile as any);
		}
		setSelectedQzPrinter(selectedPrinter.value);
		notify("Silent 80 mm receipt printing enabled for this POS Profile.", "success");
	} catch (error: any) {
		console.error("Failed to configure QZ silent printing", error);
		notify(error?.message || "Failed to enable silent printing.", "error");
	} finally {
		savingProfilePrinter.value = false;
	}
}

async function handleGenerateCertificate() {
	certificateLoading.value = true;
	try {
		const result = await setupQzCertificate();
		if (result?.status === "exists") {
			notify("Certificate already exists.", "success");
		} else {
			notify("Certificate generated successfully.", "success");
		}
	} catch (error: any) {
		console.error("Failed to generate QZ certificate", error);
		notify(error?.message || "Failed to generate certificate.", "error");
	} finally {
		certificateLoading.value = false;
	}
}

async function handleDownloadCertificate() {
	try {
		const result = await getQzCertificateDownload();
		const pem = typeof result?.pem === "string" ? result.pem.trim() : "";
		const company = typeof result?.company === "string" ? result.company.trim() : "";
		if (!pem || !company) {
			notify("Failed to download certificate. Certificate payload is incomplete.", "error");
			return;
		}
		const blob = new Blob([pem], { type: "application/x-pem-file" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = getQzCertificateFilename(company);
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		URL.revokeObjectURL(url);
		notify("Certificate downloaded.", "success");
	} catch (error: any) {
		console.error("Failed to download QZ certificate", error);
		notify(error?.message || "Failed to download certificate.", "error");
	}
}

watch(
	() => props.modelValue,
	async (open) => {
		if (!open) return;
		await checkQzCertificateOnce();
		if (!qzConnected.value && !qzReconnectPaused.value) {
			await handleConnect(false);
		} else if (qzConnected.value) {
			await refreshPrinters(false);
		}
	},
);
</script>

<style scoped>
.qz-dialog-card {
	background-color: rgb(var(--v-theme-surface));
	color: rgb(var(--v-theme-on-surface));
}
</style>
