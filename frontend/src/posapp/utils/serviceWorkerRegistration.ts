type PosServiceWorkerContainer = Pick<ServiceWorkerContainer, "register">;
type PosServiceWorkerLocation = Pick<Location, "hostname" | "protocol">;
type PosServiceWorkerLogger = Pick<Console, "error" | "log">;

export function shouldRegisterPosServiceWorker(
	serviceWorker: PosServiceWorkerContainer | null | undefined,
	location: PosServiceWorkerLocation | null | undefined,
): serviceWorker is PosServiceWorkerContainer {
	if (!serviceWorker || !location) return false;

	return (
		location.protocol === "https:" ||
		location.hostname === "localhost" ||
		location.hostname === "127.0.0.1"
	);
}

export function getPosServiceWorkerUrl(buildVersion: string | null | undefined) {
	const normalizedVersion = String(buildVersion || "").trim();
	// The worker reads version.json at runtime, so the source bytes can be the
	// same across deploys. The build query still forces the browser to evaluate
	// a new registration when the POS bundle changes.
	return normalizedVersion
		? `/sw.js?v=${encodeURIComponent(normalizedVersion)}`
		: "/sw.js";
}

export async function registerPosServiceWorker({
	buildVersion,
	serviceWorker,
	location,
	logger = console,
}: {
	buildVersion: string | null | undefined;
	serviceWorker: PosServiceWorkerContainer | null | undefined;
	location: PosServiceWorkerLocation | null | undefined;
	logger?: PosServiceWorkerLogger;
}): Promise<ServiceWorkerRegistration | null> {
	if (!shouldRegisterPosServiceWorker(serviceWorker, location)) {
		return null;
	}

	const swUrl = getPosServiceWorkerUrl(buildVersion);
	try {
		const registration = await serviceWorker.register(swUrl);
		logger.log("SW registered successfully", registration);
		return registration;
	} catch (error) {
		logger.error("SW registration failed", error);
		return null;
	}
}
