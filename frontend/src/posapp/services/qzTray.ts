import qz from "qz-tray";
import { ref } from "vue";
import { useUIStore } from "../stores/uiStore";

declare const frappe: any;

export type QzCertStatus = "unknown" | "trusted" | "untrusted";

export interface QzPrinterDetail {
	name: string;
	driver?: string;
	density?: number | number[];
	trays?: string[];
	physical?: boolean;
	type?: string;
	default?: boolean;
}

export interface QzPrinterDiscoveryResult {
	printers: string[];
	details: QzPrinterDetail[];
	defaultPrinter: string;
	recommendedPrinter: string;
	recommendationReason: "configured" | "terminal" | "receipt" | "default" | "only-physical" | "";
	ambiguous: boolean;
}

export interface QzPrintHtmlOptions {
	printerName?: string;
	widthMm?: number;
	orientation?: "portrait" | "landscape";
}

export interface QzPrintDocumentOptions extends QzPrintHtmlOptions {
	doctype: string;
	name: string;
	printFormat?: string;
	letterhead?: string | null;
	noLetterhead?: string | number | null;
}

const PRINTER_STORAGE_KEY = "posa_qz_printer_name";
const CERT_READY_STORAGE_KEY = "posa_qz_cert_ready";
const MANUAL_DISCONNECT_STORAGE_KEY = "posa_qz_manual_disconnect";
const DEFAULT_PRINT_FORMAT = "Standard";
const PROFILE_PRINTER_FIELD = "posa_qz_printer_name";
const RECEIPT_PRINTER_PATTERN = /(?:\breceipt\b|\bthermal\b|\bpos\b|80\s?mm|black\s?copper|epson\s+tm|star\s+tsp|xprinter|rongta|bixolon|citizen\s+ct)/i;
const VIRTUAL_PRINTER_PATTERN = /(?:pdf|xps|onenote|fax|document\s+writer|send\s+to|microsoft\s+print)/i;

export const qzConnected = ref(false);
export const qzConnecting = ref(false);
export const qzCertStatus = ref<QzCertStatus>("unknown");
export const qzPrinters = ref<string[]>([]);
export const qzPrinterDetails = ref<QzPrinterDetail[]>([]);
export const qzDefaultPrinter = ref("");
export const qzRecommendedPrinter = ref("");
export const selectedQzPrinter = ref(getSavedPrinterName());
export const qzCertReady = ref(loadCertReady());
export const qzReconnectPaused = ref(loadReconnectPaused());

let securityInitialized = false;
let cachedCertificate: string | null = null;
let certificateProvided = false;
let connectPromise: Promise<boolean> | null = null;
let certificateChecked = false;

function translate(text: string) {
	const translator = (globalThis as any).__ || (globalThis as any).frappe?._;
	return typeof translator === "function" ? translator(text) : text;
}

function extractMessage<T>(value: any): T {
	if (value && typeof value === "object" && "message" in value) {
		return value.message as T;
	}
	return value as T;
}

async function callServer<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
	const response = await frappe.call({
		method,
		args,
	});
	return extractMessage<T>(response);
}

function buildPrintHtml(html: string, style: string): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${style || ""}</style>
</head>
<body>${html}</body>
</html>`;
}

function loadCertReady() {
	try {
		return localStorage.getItem(CERT_READY_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

function loadReconnectPaused() {
	try {
		return localStorage.getItem(MANUAL_DISCONNECT_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

function saveCertReady(value: boolean) {
	try {
		if (value) {
			localStorage.setItem(CERT_READY_STORAGE_KEY, "1");
		} else {
			localStorage.removeItem(CERT_READY_STORAGE_KEY);
		}
	} catch {
		// ignore localStorage errors
	}
}

function saveReconnectPaused(value: boolean) {
	try {
		if (value) {
			localStorage.setItem(MANUAL_DISCONNECT_STORAGE_KEY, "1");
		} else {
			localStorage.removeItem(MANUAL_DISCONNECT_STORAGE_KEY);
		}
	} catch {
		// ignore localStorage errors
	}
}

function setReconnectPaused(value: boolean) {
	qzReconnectPaused.value = value;
	saveReconnectPaused(value);
}

function getCurrentPosProfile(): Record<string, any> | null {
	try {
		const uiStore = useUIStore();
		const profile =
			uiStore?.posProfile && typeof uiStore.posProfile === "object" && "value" in uiStore.posProfile
				? uiStore.posProfile.value
				: uiStore?.posProfile;

		return profile && typeof profile === "object" ? profile : null;
	} catch {
		// ignore store access issues outside app context
	}
	return null;
}

function getCurrentPosProfileName() {
	const value = getCurrentPosProfile()?.name;
	return typeof value === "string" ? value.trim() : "";
}

function getProfileDefaultPrinterName() {
	const value = getCurrentPosProfile()?.[PROFILE_PRINTER_FIELD];
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}

	return "";
}

function setResolvedQzPrinter(name: string) {
	selectedQzPrinter.value = name || "";
}

function resolvePreferredPrinter(printers: string[], allowFirstFallback = true) {
	const saved = getSavedPrinterName();
	if (saved && printers.includes(saved)) {
		return saved;
	}

	const profileDefault = getProfileDefaultPrinterName();
	if (profileDefault && printers.includes(profileDefault)) {
		return profileDefault;
	}

	if (selectedQzPrinter.value && printers.includes(selectedQzPrinter.value)) {
		return selectedQzPrinter.value;
	}

	return allowFirstFallback ? printers[0] || "" : "";
}

export function resolveProfilePrinterName(profilePrinterName: string | undefined, printers: string[]): string {
	if (profilePrinterName && printers.includes(profilePrinterName)) {
		return profilePrinterName;
	}
	return resolvePreferredPrinter(printers);
}

function normalizedPrinterText(detail: QzPrinterDetail) {
	return `${detail.name || ""} ${detail.driver || ""}`.trim();
}

export function isVirtualQzPrinter(detail: QzPrinterDetail) {
	if (detail.physical === false) return true;
	return VIRTUAL_PRINTER_PATTERN.test(normalizedPrinterText(detail));
}

function uniquePrinterNames(values: unknown[]) {
	const names = values
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter(Boolean);
	return Array.from(new Set(names));
}

function normalizePrinterDetails(value: unknown): QzPrinterDetail[] {
	const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
	return rows
		.map((row: any) => ({
			...row,
			name: typeof row?.name === "string" ? row.name.trim() : "",
			driver: typeof row?.driver === "string" ? row.driver.trim() : "",
		}))
		.filter((row) => Boolean(row.name));
}

export function recommendQzPrinter(
	printers: string[],
	details: QzPrinterDetail[],
	defaultPrinter = "",
	configuredPrinter = "",
	terminalPrinter = "",
): Pick<QzPrinterDiscoveryResult, "recommendedPrinter" | "recommendationReason" | "ambiguous"> {
	const available = new Set(printers);
	const detailByName = new Map(details.map((detail) => [detail.name, detail]));
	const candidates = printers.filter((name) => {
		const detail = detailByName.get(name) || { name };
		return !isVirtualQzPrinter(detail);
	});

	if (!candidates.length) {
		return { recommendedPrinter: "", recommendationReason: "", ambiguous: false };
	}

	if (configuredPrinter && available.has(configuredPrinter) && candidates.includes(configuredPrinter)) {
		return {
			recommendedPrinter: configuredPrinter,
			recommendationReason: "configured",
			ambiguous: false,
		};
	}

	if (terminalPrinter && available.has(terminalPrinter) && candidates.includes(terminalPrinter)) {
		return {
			recommendedPrinter: terminalPrinter,
			recommendationReason: "terminal",
			ambiguous: false,
		};
	}

	if (candidates.length === 1) {
		return {
			recommendedPrinter: candidates[0] || "",
			recommendationReason: "only-physical",
			ambiguous: false,
		};
	}

	const ranked = candidates
		.map((name) => {
			const detail = detailByName.get(name) || { name };
			let score = 0;
			let reason: QzPrinterDiscoveryResult["recommendationReason"] = "";
			if (RECEIPT_PRINTER_PATTERN.test(normalizedPrinterText(detail))) {
				score += 70;
				reason = "receipt";
			}
			if (name === defaultPrinter || detail.default === true) {
				score += 50;
				if (!reason) reason = "default";
			}
			if (detail.physical === true) score += 10;
			return { name, score, reason };
		})
		.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

	const first = ranked[0];
	const second = ranked[1];
	if (!first || first.score < 50 || first.score === second?.score) {
		return { recommendedPrinter: "", recommendationReason: "", ambiguous: true };
	}

	return {
		recommendedPrinter: first.name,
		recommendationReason: first.reason,
		ambiguous: false,
	};
}

function setupSecurity() {
	if (securityInitialized) return;
	securityInitialized = true;

	qz.security.setCertificatePromise((resolve) => {
		if (cachedCertificate) {
			certificateProvided = true;
			resolve(cachedCertificate);
			return;
		}

		callServer<string>("posawesome.posawesome.api.qz.get_certificate")
			.then((certificate) => {
				if (certificate) {
					cachedCertificate = certificate;
					certificateProvided = true;
					qzCertReady.value = true;
					saveCertReady(true);
				} else {
					certificateProvided = false;
					qzCertStatus.value = "untrusted";
				}
				resolve(certificate || undefined);
			})
			.catch((error) => {
				console.warn("Unable to fetch QZ certificate", error);
				certificateProvided = false;
				qzCertStatus.value = "untrusted";
				resolve(undefined);
			});
	});

	qz.security.setSignatureAlgorithm("SHA512");
	qz.security.setSignaturePromise((toSign) => {
		return (resolve) => {
			callServer<string>("posawesome.posawesome.api.qz.sign_message", {
				message: toSign,
			})
				.then((signature) => {
					if (signature && certificateProvided) {
						qzCertStatus.value = "trusted";
						qzCertReady.value = true;
						saveCertReady(true);
					} else {
						qzCertStatus.value = "untrusted";
					}
					resolve(signature || undefined);
				})
				.catch((error) => {
					console.warn("Unable to sign QZ payload", error);
					qzCertStatus.value = "untrusted";
					resolve(undefined);
				});
		};
	});
}

export function getSavedPrinterName() {
	try {
		return localStorage.getItem(getPrinterStorageKey()) || "";
	} catch {
		return "";
	}
}

export function getPrinterStorageKey() {
	const profileName = getCurrentPosProfileName();
	return profileName
		? `${PRINTER_STORAGE_KEY}:${encodeURIComponent(profileName)}`
		: PRINTER_STORAGE_KEY;
}

export function savePrinterName(name: string) {
	try {
		const storageKey = getPrinterStorageKey();
		if (name) {
			localStorage.setItem(storageKey, name);
		} else {
			localStorage.removeItem(storageKey);
		}
		if (storageKey !== PRINTER_STORAGE_KEY) localStorage.removeItem(PRINTER_STORAGE_KEY);
	} catch {
		// ignore localStorage errors
	}
}

export function setSelectedQzPrinter(name: string) {
	setResolvedQzPrinter(name);
	savePrinterName(name);
}

export async function connectQzTray(options: { userInitiated?: boolean } = {}): Promise<boolean> {
	if (options.userInitiated) {
		setReconnectPaused(false);
	}

	if (qz.websocket.isActive()) {
		qzConnected.value = true;
		return true;
	}

	if (qzReconnectPaused.value) {
		qzConnected.value = false;
		qzConnecting.value = false;
		return false;
	}

	if (connectPromise) {
		return connectPromise;
	}

	connectPromise = (async () => {
		setupSecurity();
		qzConnecting.value = true;

		qz.websocket.setClosedCallbacks(() => {
			qzConnected.value = false;
			qzConnecting.value = false;
			qzCertStatus.value = "unknown";
		});

		try {
			await qz.websocket.connect();
			qzConnected.value = true;
			qz.printers.find().catch(() => undefined);
			return true;
		} catch (error) {
			console.warn("Unable to connect to QZ Tray", error);
			qzConnected.value = false;
			return false;
		} finally {
			qzConnecting.value = false;
		}
	})();

	try {
		return await connectPromise;
	} finally {
		connectPromise = null;
	}
}

export async function disconnectQzTray(options: { manual?: boolean } = {}) {
	if (options.manual !== false) {
		setReconnectPaused(true);
	}

	if (!qz.websocket.isActive()) {
		qzConnected.value = false;
		qzConnecting.value = false;
		return;
	}

	try {
		await qz.websocket.disconnect();
	} catch (error) {
		console.warn("Unable to disconnect from QZ Tray", error);
	} finally {
		qzConnected.value = false;
		qzConnecting.value = false;
	}
}

export async function findQzPrinters(): Promise<string[]> {
	if (!qz.websocket.isActive()) {
		if (qzReconnectPaused.value) {
			qzConnected.value = false;
			return qzPrinters.value;
		}

		const connected = await connectQzTray();
		if (!connected) {
			return qzPrinters.value;
		}
	}

	try {
		const result = await qz.printers.find();
		const printers = Array.isArray(result)
			? result
			: result
				? [String(result)]
				: [];

		qzPrinters.value = printers;
		setResolvedQzPrinter(resolvePreferredPrinter(printers));

		return printers;
	} catch (error) {
		console.error("Unable to load QZ printers", error);
		qzPrinters.value = [];
		return [];
	}
}

export async function discoverQzPrinters(): Promise<QzPrinterDiscoveryResult> {
	if (!qz.websocket.isActive()) {
		if (qzReconnectPaused.value) {
			return {
				printers: qzPrinters.value,
				details: qzPrinterDetails.value,
				defaultPrinter: qzDefaultPrinter.value,
				recommendedPrinter: qzRecommendedPrinter.value,
				recommendationReason: "",
				ambiguous: false,
			};
		}
		const connected = await connectQzTray();
		if (!connected) {
			return {
				printers: [],
				details: [],
				defaultPrinter: "",
				recommendedPrinter: "",
				recommendationReason: "",
				ambiguous: false,
			};
		}
	}

	const [printerResult, defaultResult, detailResult] = await Promise.all([
		qz.printers.find().catch(() => undefined),
		qz.printers.getDefault?.().catch(() => undefined),
		qz.printers.details?.().catch(() => undefined),
	]);
	const details = normalizePrinterDetails(detailResult);
	const foundPrinters = Array.isArray(printerResult)
		? printerResult
		: printerResult
			? [String(printerResult)]
			: [];
	const printers = uniquePrinterNames([...foundPrinters, ...details.map((detail) => detail.name)]);
	const defaultPrinter = typeof defaultResult === "string" ? defaultResult.trim() : "";
	const recommendation = recommendQzPrinter(
		printers,
		details,
		defaultPrinter,
		getProfileDefaultPrinterName(),
		getSavedPrinterName(),
	);

	qzPrinters.value = printers;
	qzPrinterDetails.value = details;
	qzDefaultPrinter.value = defaultPrinter;
	qzRecommendedPrinter.value = recommendation.recommendedPrinter;

	const existingPreference = resolvePreferredPrinter(printers, false);
	setResolvedQzPrinter(existingPreference || recommendation.recommendedPrinter);

	return {
		printers,
		details,
		defaultPrinter,
		...recommendation,
	};
}

export async function checkQzCertificateOnce() {
	if (certificateChecked) {
		return qzCertReady.value;
	}

	certificateChecked = true;
	if (qzCertReady.value) {
		return true;
	}

	try {
		const certificate = await callServer<string>("posawesome.posawesome.api.qz.get_certificate");
		if (certificate) {
			cachedCertificate = certificate;
			qzCertReady.value = true;
			saveCertReady(true);
		}
	} catch {
		// certificate may not exist yet
	}

	return qzCertReady.value;
}

export async function setupQzCertificate() {
	const result = await callServer<{
		status: "exists" | "created";
		message?: string;
		cert_path?: string;
	}>("posawesome.posawesome.api.qz.setup_qz_certificate");

	qzCertReady.value = true;
	saveCertReady(true);
	return result;
}

export async function getQzCertificateDownload() {
	const result = await callServer<{ pem?: string; company?: string }>(
		"posawesome.posawesome.api.qz.get_certificate_download",
	);
	if (!result?.pem) {
		throw new Error(translate("QZ certificate is not available."));
	}
	qzCertReady.value = true;
	saveCertReady(true);
	return result;
}

export function getQzCertificateFilename(company?: string | null) {
	const clean = (company || "").replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
	return clean ? `${clean}.crt` : "certificate.crt";
}

export async function printHtmlViaQz(html: string, options: QzPrintHtmlOptions = {}) {
	if (!html) {
		throw new Error(translate("Nothing to print."));
	}

	const printer = await ensureQzPrinterReady(options.printerName);

	const config = qz.configs.create(printer, {
		size: {
			width: options.widthMm || 80,
			height: null,
		},
		units: "mm",
		orientation: options.orientation || "portrait",
		margins: { top: 0, right: 0, bottom: 0, left: 0 },
		colorType: "grayscale",
		interpolation: "nearest-neighbor",
	});

	const data = [
		{
			type: "pixel",
			format: "html",
			flavor: "plain",
			data: html,
		},
	];

	await qz.print(config, data);
}

function escapePrinterTestText(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export async function printQzSetupTestPage(printerName: string) {
	const safePrinterName = escapePrinterTestText(printerName || "");
	const html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		@page { size: 80mm auto; margin: 0; }
		* { box-sizing: border-box; }
		body { width: 80mm; margin: 0; padding: 3mm; font-family: Arial, sans-serif; color: #000; }
		.receipt { width: 74mm; font-size: 11px; line-height: 1.35; }
		h1 { margin: 0 0 2mm; font-size: 16px; text-align: center; }
		.rule { border-top: 1px dashed #000; margin: 2mm 0; }
		.edge { display: flex; justify-content: space-between; font-weight: 700; }
	</style>
</head>
<body>
	<div class="receipt">
		<h1>RetailMind Printer Test</h1>
		<div class="rule"></div>
		<div>Printer: ${safePrinterName}</div>
		<div>Paper: 80 mm / safe content: 74 mm</div>
		<div class="rule"></div>
		<div class="edge"><span>| LEFT EDGE</span><span>RIGHT EDGE |</span></div>
		<div class="rule"></div>
		<div style="text-align:center">Confirm text fits, the correct queue printed, and no browser or QZ prompt appeared.</div>
		<br><br>
	</div>
</body>
</html>`;

	await printHtmlViaQz(html, { printerName, widthMm: 80 });
}

export async function sendRawToQz(data: string, printerName?: string) {
	const printer = await ensureQzPrinterReady(printerName);

	const config = qz.configs.create(printer);
	const printData = [
		{
			type: "raw",
			format: "command",
			flavor: "plain",
			data: data,
		},
	];

	await qz.print(config, printData);
}

async function ensureQzPrinterReady(printerName?: string) {
	if (!qz.websocket.isActive()) {
		const connected = await connectQzTray();
		if (!connected) {
			if (qzReconnectPaused.value) {
				throw new Error(translate("QZ Tray is manually disconnected. Press Connect to enable it again."));
			}
			throw new Error(translate("QZ Tray is not available."));
		}
	}

	let printer =
		printerName ||
		getSavedPrinterName() ||
		getProfileDefaultPrinterName() ||
		selectedQzPrinter.value;
	if (!printer) {
		const printers = await findQzPrinters();
		if (printers[0]) {
			printer = printers[0];
			setResolvedQzPrinter(printers[0]);
		}
	}

	if (!printer) {
		throw new Error(translate("No QZ printer selected."));
	}

	return printer;
}

export async function printDocumentViaQz(options: QzPrintDocumentOptions) {
	if (!options?.doctype || !options?.name) {
		throw new Error(translate("Invalid print document details."));
	}

	const printFormat = options.printFormat || DEFAULT_PRINT_FORMAT;
	const noLetterhead =
		options.letterhead && String(options.letterhead).trim() ? 0 : options.noLetterhead ?? 1;

	const response = await frappe.call({
		method: "frappe.www.printview.get_html_and_style",
		args: {
			doc: options.doctype,
			name: options.name,
			print_format: printFormat,
			no_letterhead: noLetterhead,
			letterhead: options.letterhead || undefined,
		},
	});

	const html = response?.html || response?.message?.html;
	const style = response?.style || response?.message?.style || "";

	if (!html) {
		throw new Error(translate("Unable to load print HTML from server."));
	}

	await printHtmlViaQz(buildPrintHtml(html, style), options);
}
