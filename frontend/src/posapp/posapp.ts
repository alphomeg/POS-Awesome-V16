import { createApp } from "vue";
// @ts-ignore
import vuetify from "./plugins/vuetify";
import "@mdi/font/css/materialdesignicons.css";
import "@fontsource/roboto/100.css";
import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "@fontsource/roboto/900.css";
// @ts-ignore
import Dexie from "dexie/dist/dexie.mjs";
import VueDatePicker from "@vuepic/vue-datepicker";
import "@vuepic/vue-datepicker/dist/main.css";
import "../../../posawesome/public/css/rtl.css";
import "../style.css";
import "./styles/theme.css";
import "./styles/counter-grid.css";
import eventBus from "./bus";
import themePlugin from "./plugins/theme";
import { pinia } from "./stores";
import { useToastStore } from "./stores/toastStore";
import { useSocketStore } from "./stores/socketStore";
import { createPosAppRouter } from "./router";
import {
	installGlobalErrorHandlers,
	isBenignGlobalError,
} from "./utils/errorReporting";
import {
	clearChunkRecoveryState,
	isDynamicImportFailure,
	recoverFromChunkLoadError,
	scheduleAfterStableBoot,
	scheduleChunkRecoveryStateReset,
} from "./utils/chunkLoadRecovery";
import { registerPosServiceWorker } from "./utils/serviceWorkerRegistration";
import { finalizePendingBundleActivation } from "./utils/bundleVersionActivation";
import { reconcileBuildChangeOnStartup } from "./utils/buildCacheReconciler";
import {
	startupInitPromise,
	isOffline,
	isOfflineStorageReady,
	registerPostHydrationTask,
} from "../offline";
import App from "./App.vue";
// @ts-ignore
import {
	attachProfilerHelpers,
	initLongTaskObserver,
	isPerfEnabled,
} from "./utils/perf.js";

declare const __BUILD_VERSION__: string;

attachProfilerHelpers();

// Expose Dexie globally for libraries that expect a global Dexie instance
if (typeof window !== "undefined" && !(window as any).Dexie) {
	(window as any).Dexie = Dexie;
}

if (typeof frappe === "undefined") {
	console.error("Frappe is not defined");
} else {
	frappe.provide("frappe.PosApp");
}

export async function initPosStorage() {
	await startupInitPromise;
}

function getPosBuildVersion() {
	return typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : null;
}

let posServiceWorkerRegistration: Promise<ServiceWorkerRegistration | null> | null =
	null;

function ensurePosServiceWorkerRegistration() {
	if (posServiceWorkerRegistration) {
		return posServiceWorkerRegistration;
	}

	const serviceWorker =
		typeof navigator !== "undefined" && "serviceWorker" in navigator
			? navigator.serviceWorker
			: null;
	const location = typeof window !== "undefined" ? window.location : null;
	posServiceWorkerRegistration = registerPosServiceWorker({
		buildVersion: getPosBuildVersion(),
		serviceWorker,
		location,
	}).then((registration) => {
		if (!registration) {
			posServiceWorkerRegistration = null;
		}
		return registration;
	});
	return posServiceWorkerRegistration;
}

let buildReconciliationChain: Promise<unknown> = Promise.resolve();

function queueBuildReconciliation(deferInitialBaseline: boolean) {
	const reconcile = async () =>
		await reconcileBuildChangeOnStartup({
			runtimeBuildVersion: getPosBuildVersion(),
			isOnline: !isOffline(),
			deferInitialBaseline,
		});
	buildReconciliationChain = buildReconciliationChain.then(
		reconcile,
		reconcile,
	);
	return buildReconciliationChain;
}

const POS_INPUT_HELPER_SELECTOR = "input, textarea";

function suppressBrowserInputHelpers(root: HTMLElement | null | undefined) {
	if (
		!root ||
		typeof window === "undefined" ||
		typeof MutationObserver === "undefined"
	) {
		return () => {};
	}

	const normalizeInput = (element: Element | null) => {
		if (
			!(
				element instanceof HTMLInputElement ||
				element instanceof HTMLTextAreaElement
			)
		) {
			return;
		}
		if (
			element.type === "file" ||
			element.dataset.posAllowBrowserHelpers === "true"
		) {
			return;
		}
		element.setAttribute("autocomplete", "off");
		element.setAttribute("autocorrect", "off");
		element.setAttribute("autocapitalize", "off");
		element.setAttribute("spellcheck", "false");
	};

	const normalizeTree = (node: ParentNode | Element | null) => {
		if (!node) return;
		if (node instanceof Element) {
			normalizeInput(node);
		}
		node.querySelectorAll?.(POS_INPUT_HELPER_SELECTOR).forEach(
			normalizeInput,
		);
	};

	const handleFocusIn = (event: Event) => {
		normalizeInput(event.target as Element | null);
	};

	normalizeTree(root);
	const observer = new MutationObserver((mutations) => {
		mutations.forEach((mutation) => {
			mutation.addedNodes.forEach((node) => {
				if (node instanceof Element) {
					normalizeTree(node);
				}
			});
		});
	});
	observer.observe(root, { childList: true, subtree: true });
	root.addEventListener("focusin", handleFocusIn, true);

	return () => {
		observer.disconnect();
		root.removeEventListener("focusin", handleFocusIn, true);
	};
}

registerPostHydrationTask(async () => {
	await queueBuildReconciliation(false);
});

export async function runPosBootSync() {
	if (!isOfflineStorageReady()) {
		return;
	}
	await queueBuildReconciliation(true);
}

async function startOptionalRuntimeServices() {
	const socketStore = useSocketStore();
	socketStore.init();

	await import("../sw-updater").catch((error) => {
		console.warn("Failed to initialize POS service worker updater", error);
	});

	if (!document.querySelector('link[rel="manifest"]')) {
		const link = document.createElement("link");
		link.rel = "manifest";
		link.href = "/manifest.json";
		document.head.appendChild(link);
	}
}

class PosAppController {
	$parent: any;
	page: any;
	app: any;
	router: any;
	routerHistory: any;
	$el: any;
	inputHelperCleanup: (() => void) | null;

	constructor(input: any) {
		const parent = input?.parent || input;
		this.$parent = $(document);
		this.page = parent?.page || parent;
		this.app = null;
		this.inputHelperCleanup = null;
		this.make_body();
	}

	make_body() {
		this.$el = this.$parent.find(".main-section");
	}

	async initializeApp() {
		// Vuetify instance is now imported from plugins/vuetify.ts
		this.app = createApp(App);
		const { router, history } = createPosAppRouter();
		this.router = router;
		this.routerHistory = history;
		this.app.component("VueDatePicker", VueDatePicker);
		this.app.use(pinia);
		this.app.use(this.router);
		this.app.use(eventBus);
		this.app.use(vuetify);
		this.app.use(themePlugin, { vuetify });

		this.app.config.errorHandler = (
			err: any,
			_instance: any,
			info: string,
		) => {
			if (isDynamicImportFailure(err)) {
				void recoverFromChunkLoadError(err, "vue-error-handler");
				return;
			}

			if (!isBenignGlobalError(err)) {
				console.error("Global Error:", err, info);
				const toastStore = useToastStore();
				toastStore.show({
					message: `An unexpected error occurred: ${err?.message || err}`,
					color: "error",
					timeout: 5000,
				});
			}
		};

		installGlobalErrorHandlers(this.app);

		this.app.mount(this.$el[0]);
		this.inputHelperCleanup = suppressBrowserInputHelpers(this.$el[0]);
		// The shell registration must not wait for deferred updater/socket work.
		// A first terminal reload can otherwise happen before this controller exists.
		void ensurePosServiceWorkerRegistration();
		clearChunkRecoveryState();
		void this.router.isReady().finally(() => {
			scheduleChunkRecoveryStateReset();
			scheduleAfterStableBoot(() => {
				void finalizePendingBundleActivation();
				void startOptionalRuntimeServices();
			});
		});

		if (isPerfEnabled()) {
			initLongTaskObserver("posapp");
		}

		return this;
	}

	unmount() {
		if (this.app) {
			this.inputHelperCleanup?.();
			this.inputHelperCleanup = null;
			// Clean up router to prevent global navigation interference
			if (this.router) {
				// Remove all route guards and listeners
				this.router.beforeEachCbs = [];
				this.router.afterEachCbs = [];
			}

			if (
				this.routerHistory &&
				typeof this.routerHistory.destroy === "function"
			) {
				this.routerHistory.destroy();
			} else if (
				this.router &&
				this.router.options &&
				this.router.options.history &&
				typeof this.router.options.history.destroy === "function"
			) {
				this.router.options.history.destroy();
			}

			this.app.unmount();
			this.app = null;
			this.router = null;
			this.routerHistory = null;
			console.info("POS App unmounted");
		}
	}

	setup_header() {}
}

export async function mountPosApp(pageRef: any) {
	if (pageRef?.$PosApp) {
		return pageRef.$PosApp;
	}

	const instance = new PosAppController(pageRef);
	await instance.initializeApp();
	if (pageRef) {
		pageRef.$PosApp = instance;
	}
	return instance;
}

frappe.PosApp!.posapp = class extends PosAppController {
	constructor(pageRef: any) {
		super(pageRef);
		void this.initializeApp();
	}
};
