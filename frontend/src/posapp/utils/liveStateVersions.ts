export interface StockVersionToken {
	epoch: string | null;
	version: number | null;
}

export interface StockVersionDecision {
	accept: boolean;
	gap: boolean;
	reason: "initial" | "next" | "gap" | "new_epoch" | "stale" | "unversioned";
}

const versionsByWarehouse = new Map<string, StockVersionToken>();

const normalizeToken = (value: any): StockVersionToken => {
	const epoch =
		typeof value?.epoch === "string" && value.epoch.trim()
			? value.epoch.trim()
			: null;
	const parsed = Number(value?.version);
	return {
		epoch,
		version:
			value?.version !== null &&
			value?.version !== undefined &&
			Number.isFinite(parsed)
				? parsed
				: null,
	};
};

export const installStockVersionSnapshot = (
	versions: Record<string, StockVersionToken> = {},
) => {
	Object.entries(versions || {}).forEach(([warehouse, rawToken]) => {
		if (!warehouse) return;
		versionsByWarehouse.set(warehouse, normalizeToken(rawToken));
	});
};

export const evaluateStockVersion = (
	warehouse: string | null | undefined,
	rawToken: StockVersionToken | null | undefined,
): StockVersionDecision => {
	if (!warehouse) {
		return { accept: true, gap: false, reason: "unversioned" };
	}
	const incoming = normalizeToken(rawToken);
	if (!incoming.epoch || incoming.version === null) {
		return { accept: true, gap: false, reason: "unversioned" };
	}

	const current = versionsByWarehouse.get(warehouse);
	if (!current?.epoch || current.version === null) {
		versionsByWarehouse.set(warehouse, incoming);
		return { accept: true, gap: false, reason: "initial" };
	}
	if (current.epoch !== incoming.epoch) {
		versionsByWarehouse.set(warehouse, incoming);
		return { accept: true, gap: true, reason: "new_epoch" };
	}
	if (incoming.version <= current.version) {
		return { accept: false, gap: false, reason: "stale" };
	}

	const gap = incoming.version > current.version + 1;
	versionsByWarehouse.set(warehouse, incoming);
	return {
		accept: true,
		gap,
		reason: gap ? "gap" : "next",
	};
};

export const resetStockVersions = () => versionsByWarehouse.clear();

