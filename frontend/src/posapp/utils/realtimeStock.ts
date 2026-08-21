import stockCoordinator from "./stockCoordinator";
import { bus } from "../bus";
import {
	evaluateStockVersion,
	type StockVersionToken,
} from "./liveStateVersions";

export interface RealtimeStockItem {
	item_code: string;
	warehouse: string | null;
	company: string | null;
	actual_qty: number | null;
	stock_version: StockVersionToken | null;
}

export interface RealtimeStockPayload {
	items: RealtimeStockItem[];
	item_codes: string[];
	warehouses: string[];
	companies: string[];
	source_doctype: string | null;
	stock_versions: Record<string, StockVersionToken>;
	has_version_gap: boolean;
}

// A browser event survives a transient duplicate module graph during a
// versioned POS asset transition. The in-memory bus remains the normal fast
// path; consumers deduplicate the shared payload when they observe both.
export const REMOTE_STOCK_ADJUSTMENT_EVENT = "posa:remote-stock-adjustment";

type DispatchDeps = {
	emit?: (_event: string, _payload: RealtimeStockPayload) => void;
	setLastStockAdjustment?: (_payload: RealtimeStockPayload) => void;
	updateBaseQuantities?: (
		_entries: Array<{ item_code: string; warehouse?: string | null; actual_qty: number }>,
		_options?: { source?: string },
	) => void;
};

const normalizeString = (value: unknown): string | null => {
	if (value === undefined || value === null) {
		return null;
	}
	const normalized = String(value).trim();
	return normalized ? normalized : null;
};

const normalizeQty = (value: unknown): number | null => {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

export function normalizeRealtimeStockPayload(
	input: any,
): RealtimeStockPayload | null {
	const rows = Array.isArray(input?.items)
		? input.items
		: input && typeof input === "object"
			? [input]
			: [];

	const items: RealtimeStockItem[] = rows
		.map((row) => {
			const item_code = normalizeString(
				row?.item_code ?? row?.itemCode ?? row?.code,
			);
			if (!item_code) {
				return null;
			}

			return {
				item_code,
				warehouse: normalizeString(row?.warehouse),
				company: normalizeString(row?.company),
				actual_qty: normalizeQty(
					row?.actual_qty ?? row?.actualQty ?? row?.available_qty,
				),
				stock_version: row?.stock_version || null,
			};
		})
		.filter((row): row is RealtimeStockItem => !!row);

	if (!items.length) {
		return null;
	}

	const stock_versions =
		input?.stock_versions && typeof input.stock_versions === "object"
			? input.stock_versions
			: {};
	let has_version_gap = false;
	const acceptedItems = items.filter((row) => {
		const token =
			row.stock_version ||
			(row.warehouse ? stock_versions[row.warehouse] : null);
		const decision = evaluateStockVersion(row.warehouse, token);
		if (decision.gap) has_version_gap = true;
		return decision.accept;
	});
	if (!acceptedItems.length && !has_version_gap) {
		return null;
	}

	return {
		items: acceptedItems,
		item_codes: Array.from(
			new Set(acceptedItems.map((row) => row.item_code)),
		),
		warehouses: Array.from(
			new Set(
				acceptedItems
					.map((row) => row.warehouse)
					.filter(Boolean) as string[],
			),
		),
		companies: Array.from(
			new Set(
				acceptedItems
					.map((row) => row.company)
					.filter(Boolean) as string[],
			),
		),
		source_doctype: normalizeString(input?.source_doctype),
		stock_versions,
		has_version_gap,
	};
}

export function dispatchRealtimeStockPayload(
	input: any,
	deps: DispatchDeps = {},
): RealtimeStockPayload | null {
	const payload = normalizeRealtimeStockPayload(input);
	if (!payload) {
		return null;
	}

	const updateBaseQuantities =
		deps.updateBaseQuantities || stockCoordinator.updateBaseQuantities;
	const emit = deps.emit || bus.emit;
	const baseEntries = payload.items
		.filter(
			(row): row is RealtimeStockItem & { actual_qty: number } =>
				typeof row.actual_qty === "number",
		)
		.map((row) => ({
			item_code: row.item_code,
			warehouse: row.warehouse,
			actual_qty: row.actual_qty,
		}));

	if (baseEntries.length) {
		updateBaseQuantities(baseEntries, { source: "realtime" });
	}

	if (deps.setLastStockAdjustment) {
		deps.setLastStockAdjustment(payload);
	}

	emit("remote_stock_adjustment", payload);
	if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
		window.dispatchEvent(
			new CustomEvent(REMOTE_STOCK_ADJUSTMENT_EVENT, { detail: payload }),
		);
	}
	if (payload.has_version_gap) {
		emit("stock_version_gap", payload);
	}
	return payload;
}
