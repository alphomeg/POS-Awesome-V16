/**
 * Pinia Store for Items Management in POSAwesome
 * Optimized state management with multi-layer caching and performance improvements
 */

import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import type { Item, POSProfile } from "../types/models";
import itemService from "../services/itemService";
import {
	getItemsLastSync,
	isOffline,
	isOfflineStorageReady,
	refreshBootstrapSnapshotFromCacheState,
} from "../../offline/index";

// Composables
import { useItemsCache } from "../composables/pos/items/store/useItemsCache";
import { useItemsSearch } from "../composables/pos/items/store/useItemsSearch";
import { useItemsSync } from "../composables/pos/items/store/useItemsSync";
import { useItemsPagination } from "../composables/pos/items/store/useItemsPagination";
import { useItemsMetrics } from "../composables/pos/items/store/useItemsMetrics";
import {
	buildLoadItemsRequest,
	type LoadItemsOptions,
} from "./items/loadItemsRequest";
import { resetItemLoadingCoordinator } from "../modules/items/itemLoadingCoordinator";
import stockCoordinator from "../utils/stockCoordinator";
import { installStockVersionSnapshot } from "../utils/liveStateVersions";

export const useItemsStore = defineStore("items", () => {
	const SERVER_SEARCH_FALLBACK_DEBOUNCE_MS = 40;
	const SERVER_SEARCH_MISS_CACHE_TTL_MS = 30 * 1000;
	const SERVER_SEARCH_RESULT_CACHE_TTL_MS = 60 * 1000;
	const SERVER_SEARCH_FALLBACK_MIN_LENGTH = 2;
	const RESUME_RECOVERY_COOLDOWN_MS = 10 * 1000;
	const HOT_CATALOG_DEFAULT_LIMIT = 5000;
	const HOT_CATALOG_MAX_LIMIT = 10000;
	const HOT_CATALOG_DAYS = 120;
	const LIVE_HYDRATION_LIMIT = 20;
	const LIVE_HYDRATION_DEBOUNCE_MS = 20;
	type OfflineModule = Record<string, any>;
	let offlineApiPromise: Promise<OfflineModule> | null = null;
	let serverSearchFallbackTimer: ReturnType<typeof setTimeout> | null = null;
	let resolvePendingServerSearchFallback: ((_items: Item[]) => void) | null =
		null;
	let serverSearchFallbackToken = 0;
	let lastRecoveryAt = 0;
	let liveHydrationTimer: ReturnType<typeof setTimeout> | null = null;
	let liveHydrationController: AbortController | null = null;
	let liveHydrationToken = 0;
	const serverSearchMissCache = new Map<string, number>();
	const serverSearchResultCache = new Map<
		string,
		{ timestamp: number; items: Item[] }
	>();
	const activeServerSearchKeys = new Set<string>();
	type SearchItemsOptions = {
		serverFallbackDelayMs?: number;
		resultLimit?: number;
		forceServer?: boolean;
	};

	const getOfflineApi = async (): Promise<OfflineModule> => {
		if (!offlineApiPromise) {
			offlineApiPromise = import("../../offline/index")
				.then((mod) => mod as OfflineModule)
				.catch((error) => {
					offlineApiPromise = null;
					console.warn("Failed to load offline module", error);
					return {};
				});
		}
		return await offlineApiPromise;
	};

	const getOfflineFn = async (name: string) => {
		const api = await getOfflineApi();
		return api[name];
	};

	const getStoredItemsCountByScopeCompat = async (scope = "") => {
		const scopedCountFn = await getOfflineFn("getStoredItemsCountByScope");
		if (typeof scopedCountFn === "function") {
			return await scopedCountFn(scope);
		}

		const legacyCountFn = await getOfflineFn("getStoredItemsCount");
		if (typeof legacyCountFn === "function") {
			console.warn(
				"offline/index.js missing getStoredItemsCountByScope; using legacy getStoredItemsCount fallback.",
			);
			return await legacyCountFn();
		}

		return 0;
	};

	const getAllStoredItemsCompat = async (scope = "") => {
		const scopedGetAllFn = await getOfflineFn("getAllStoredItems");
		if (typeof scopedGetAllFn === "function") {
			return await scopedGetAllFn(scope);
		}

		const legacyGetAllFn = await getOfflineFn("getStoredItems");
		if (typeof legacyGetAllFn === "function") {
			console.warn(
				"offline/index.js missing getAllStoredItems; using legacy getStoredItems fallback.",
			);
			return await legacyGetAllFn();
		}

		return [];
	};

	const clearStoredItemsCompat = async (scope = "") => {
		const clearStoredItemsFn = await getOfflineFn("clearStoredItems");
		if (typeof clearStoredItemsFn === "function") {
			await clearStoredItemsFn(scope);
		}
	};

	const searchStoredItemsCompat = async (args: any) => {
		const searchFn = await getOfflineFn("searchStoredItems");
		if (typeof searchFn !== "function") {
			return [];
		}
		return await searchFn(args);
	};

	const searchExactStoredItemsCompat = async (args: any) => {
		const searchFn = await getOfflineFn("searchExactStoredItems");
		if (typeof searchFn !== "function") {
			return [];
		}
		return await searchFn(args);
	};

	const getCachedPriceListItemsCompat = async (priceList: string) => {
		const fn = await getOfflineFn("getCachedPriceListItems");
		if (typeof fn !== "function") {
			return null;
		}
		return await fn(priceList);
	};

	const syncBootstrapItemReadiness = (count: number | boolean) => {
		refreshBootstrapSnapshotFromCacheState({
			itemsCount: count,
		});
	};

	// Core State
	const items = ref<Item[]>([]);
	const filteredItems = ref<Item[]>([]);
	const filteredItemsSearchTerm = ref("");
	const totalItemCount = ref(0);
	const itemsLoaded = ref(false);
	const searchTerm = ref("");
	const itemGroup = ref("ALL");
	const lastSearch = ref("");
	const lastItemCatalogSyncTime = ref<string | null>(null);
	const posProfile = ref<POSProfile | null>(null);
	const customer = ref<string | null>(null);
	const customerPriceList = ref<string | null>(null);
	const hotItems = ref<Item[]>([]);
	const hotItemsLoaded = ref(false);
	const hotItemsLoading = ref(false);
	const hotCatalogScopeKey = ref("");
	const lastLiveVerificationAt = ref<string | null>(null);
	const liveVerificationInFlight = ref(false);
	let hotCatalogRequestToken = 0;

	// Composables Initialization
	const {
		cache,
		cacheHealth,
		assessCacheHealth,
		clearAllCaches,
		clearSearchCache,
		getCachedItems,
		cacheItems,
		getCachedSearchResult,
		setCachedSearchResult,
		getCachedPriceList,
		setCachedPriceList,
		generateCacheKey,
	} = useItemsCache();

	const {
		itemsMap,
		barcodeIndex,
		updateIndexes,
		resetIndexes,
		performLocalSearch,
		performRankedLocalSearch,
		filterItemsByGroup,
		getItemByCode,
		getItemByBarcode,
	} = useItemsSearch();

	const hotSearch = useItemsSearch();

	const {
		isLoading,
		isBackgroundLoading,
		loadProgress,
		syncedItemsCount,
		requestToken,
		abortControllers,
		backgroundSyncState,
		itemGroups,
		loadItemGroups,
		persistItemsToStorage,
		primeItemDetailsCache,
		cancelBackgroundSync,
		refreshModifiedItems: syncRefreshModifiedItems,
		backgroundSyncItems: syncBackgroundSyncItems,
	} = useItemsSync();

	const {
		cachedPagination,
		DEFAULT_PAGE_SIZE,
		LARGE_CATALOG_THRESHOLD,
		resolvePageSize: paginationResolvePageSize,
		resolveLimitSearchSize,
		resetCachedPagination: paginationResetCachedPagination,
		updateCachedPaginationFromStorage,
	} = useItemsPagination();

	const {
		performanceMetrics,
		updatePerformanceMetrics,
		getEstimatedMemoryUsage,
	} = useItemsMetrics();

	// Helpers
	const normalizeBooleanSetting = (value: any): boolean => {
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			return (
				normalized === "1" ||
				normalized === "true" ||
				normalized === "yes"
			);
		}
		if (typeof value === "number") {
			return value === 1;
		}
		return Boolean(value);
	};

	const limitSearchEnabled = computed(() => {
		const rawValue =
			posProfile.value?.posa_use_limit_search ??
			posProfile.value?.pose_use_limit_search;
		return normalizeBooleanSetting(rawValue);
	});

	const fastCounterEnabled = computed(() =>
		normalizeBooleanSetting(posProfile.value?.posa_fast_counter_mode),
	);

	const resolvePageSize = (pageSize = DEFAULT_PAGE_SIZE): number => {
		return paginationResolvePageSize(
			posProfile.value,
			limitSearchEnabled.value,
			pageSize,
		);
	};

	const resetCachedPagination = (
		options: { enabled?: boolean; total?: number; pageSize?: number } = {},
	) => {
		paginationResetCachedPagination(
			options,
			posProfile.value,
			limitSearchEnabled.value,
		);
	};

	const isCatalogPersistenceConfigured = () => {
		const configured = posProfile.value?.posa_local_storage;
		return configured == null
			? true
			: normalizeBooleanSetting(configured);
	};

	const shouldPersistItems = () =>
		isCatalogPersistenceConfigured() && isOfflineStorageReady();

	const hybridVerifiedEnabled = computed(
		() =>
			fastCounterEnabled.value &&
			shouldPersistItems() &&
			!normalizeBooleanSetting(posProfile.value?.posa_force_server_items),
	);

	const shouldUseIndexedSearch = () => {
		if (limitSearchEnabled.value || !shouldPersistItems()) {
			return false;
		}
		return true;
	};

	const getCacheScope = () => {
		const profileName = posProfile.value?.name || "no_profile";
		const warehouse = posProfile.value?.warehouse || "no_warehouse";
		return `${profileName}_${warehouse}`;
	};

	const getStorageScope = () => getCacheScope();

	const normalizeSearchScope = (value: unknown) =>
		typeof value === "string" ? value.trim().toLowerCase() : "";

	const mergeItemsPreservingOrder = (
		current: Item[],
		incoming: Item[],
		limit = resolvePageSize(),
	) => {
		const incomingByCode = new Map(
			(incoming || [])
				.filter((item) => item?.item_code)
				.map((item) => [item.item_code, item]),
		);
		const seen = new Set<string>();
		const merged: Item[] = [];
		for (const item of current || []) {
			if (!item?.item_code || seen.has(item.item_code)) continue;
			const update = incomingByCode.get(item.item_code);
			if (update) Object.assign(item, update);
			seen.add(item.item_code);
			merged.push(item);
		}
		for (const item of incoming || []) {
			if (!item?.item_code || seen.has(item.item_code)) continue;
			seen.add(item.item_code);
			merged.push(item);
		}
		return merged.slice(0, limit);
	};

	const applyLiveItemState = (
		response: any,
		requestedItems: Item[],
		searchScope: string,
	) => {
		installStockVersionSnapshot(response?.stock_versions || {});
		const details = Array.isArray(response?.items) ? response.items : [];
		const detailByCode = new Map<string, Item>(
			details
				.filter((item: Item) => item?.item_code)
				.map((item: Item) => [item.item_code, item]),
		);
		const unavailable = new Set<string>(
			Array.isArray(response?.unavailable_item_codes)
				? response.unavailable_item_codes
				: [],
		);
		const targets = [items.value, hotItems.value, filteredItems.value];
		const seenTargets = new Set<Item>();
		for (const targetList of targets) {
			for (const item of targetList) {
				if (!item?.item_code || seenTargets.has(item)) continue;
				seenTargets.add(item);
				const detail = detailByCode.get(item.item_code);
				if (detail) {
					Object.assign(item, detail, {
						original_rate:
							detail.price_list_rate ??
							detail.rate ??
							item.original_rate,
						original_currency:
							detail.currency || item.original_currency,
						_posa_live_state_status: response?.verified
							? "verified"
							: "last_known",
						_posa_live_state_as_of: response?.as_of || null,
						_posa_stock_versions: response?.stock_versions || {},
					});
				} else if (unavailable.has(item.item_code)) {
					item._posa_live_state_status = "unavailable";
				}
			}
		}

		stockCoordinator.updateBaseQuantities(details, {
			source: "hybrid-live-state",
		});
		lastLiveVerificationAt.value = response?.as_of || new Date().toISOString();

		if (normalizeSearchScope(filteredItemsSearchTerm.value) === searchScope) {
			filteredItems.value = filteredItems.value.filter(
				(item) => !unavailable.has(item.item_code),
			);
			filteredItems.value = [...filteredItems.value];
		}
		for (const item of requestedItems) {
			if (
				item?._posa_live_state_status === "verifying" &&
				!detailByCode.has(item.item_code) &&
				!unavailable.has(item.item_code)
			) {
				item._posa_live_state_status = "last_known";
			}
		}
	};

	const hydrateLiveItems = async (
		candidateItems: Item[] = filteredItems.value,
		options: { reason?: string; force?: boolean } = {},
	) => {
		const unique = mergeItemsPreservingOrder([], candidateItems, LIVE_HYDRATION_LIMIT);
		if (!unique.length || !posProfile.value?.name) return [];
		if (isOffline()) {
			unique.forEach((item) => {
				item._posa_live_state_status = "last_known";
			});
			return unique;
		}

		const requestToken = ++liveHydrationToken;
		if (liveHydrationController) liveHydrationController.abort();
		liveHydrationController = new AbortController();
		const searchScope = normalizeSearchScope(searchTerm.value);
		unique.forEach((item) => {
			item._posa_live_state_status = "verifying";
		});
		filteredItems.value = [...filteredItems.value];
		liveVerificationInFlight.value = true;

		try {
			const response = await itemService.getLiveItemStateData(
				{
					pos_profile: posProfile.value.name,
					item_codes: unique.map((item) => item.item_code),
					price_list: activePriceList.value,
					customer: customer.value,
				},
				liveHydrationController.signal,
			);
			if (requestToken !== liveHydrationToken) return [];
			applyLiveItemState(response, unique, searchScope);
			return response.items || [];
		} catch (error: any) {
			if (error?.name !== "AbortError") {
				console.warn(
					`Live item verification failed (${options.reason || "search"})`,
					error,
				);
				unique.forEach((item) => {
					item._posa_live_state_status = "last_known";
				});
				filteredItems.value = [...filteredItems.value];
			}
			return [];
		} finally {
			if (requestToken === liveHydrationToken) {
				liveVerificationInFlight.value = false;
				liveHydrationController = null;
			}
		}
	};

	const scheduleLiveHydration = (
		candidateItems: Item[],
		reason = "search",
	) => {
		if (liveHydrationTimer) clearTimeout(liveHydrationTimer);
		liveHydrationTimer = setTimeout(() => {
			liveHydrationTimer = null;
			void hydrateLiveItems(candidateItems, { reason });
		}, LIVE_HYDRATION_DEBOUNCE_MS);
	};

	const setFilteredItems = (nextItems: Item[], searchScope = "") => {
		filteredItems.value = Array.isArray(nextItems) ? nextItems : [];
		filteredItemsSearchTerm.value = normalizeSearchScope(searchScope);
		if (hybridVerifiedEnabled.value && filteredItems.value.length) {
			scheduleLiveHydration(filteredItems.value, "visible-results");
		}
	};

	const isLargeCatalogWindow = () =>
		cachedPagination.value.enabled ||
		totalItemCount.value > LARGE_CATALOG_THRESHOLD;

	const buildServerSearchScopeKey = (term: string, group: string) =>
		[
			getCacheScope(),
			activePriceList.value || "default",
			group || "ALL",
			normalizeSearchScope(term),
		].join("|");

	const buildServerSearchResultCacheKey = (
		term: string,
		group: string,
		limit: number,
	) =>
		[
			buildServerSearchScopeKey(term, group),
			Math.max(1, limit || resolvePageSize()),
		].join("|");

	const isServerSearchMissCached = (scopeKey: string) => {
		const timestamp = serverSearchMissCache.get(scopeKey);
		if (!timestamp) {
			return false;
		}
		if (Date.now() - timestamp > SERVER_SEARCH_MISS_CACHE_TTL_MS) {
			serverSearchMissCache.delete(scopeKey);
			return false;
		}
		return true;
	};

	const markServerSearchMiss = (scopeKey: string) => {
		serverSearchMissCache.set(scopeKey, Date.now());
	};

	const getCachedServerSearchResult = (cacheKey: string) => {
		const cached = serverSearchResultCache.get(cacheKey);
		if (!cached) return null;
		if (Date.now() - cached.timestamp > SERVER_SEARCH_RESULT_CACHE_TTL_MS) {
			serverSearchResultCache.delete(cacheKey);
			return null;
		}
		return [...cached.items];
	};

	const setCachedServerSearchResult = (cacheKey: string, result: Item[]) => {
		serverSearchResultCache.set(cacheKey, {
			timestamp: Date.now(),
			items: Array.isArray(result) ? [...result] : [],
		});
	};

	const abortActiveServerSearches = () => {
		for (const key of Array.from(activeServerSearchKeys)) {
			const controller = abortControllers.value.get(key);
			if (controller) {
				controller.abort();
			}
			abortControllers.value.delete(key);
			activeServerSearchKeys.delete(key);
		}
	};

	const cancelPendingServerSearchFallback = (result: Item[] = []) => {
		if (serverSearchFallbackTimer) {
			clearTimeout(serverSearchFallbackTimer);
			serverSearchFallbackTimer = null;
		}
		serverSearchFallbackToken++;
		abortActiveServerSearches();
		if (resolvePendingServerSearchFallback) {
			resolvePendingServerSearchFallback(result);
			resolvePendingServerSearchFallback = null;
		}
	};

	const abortAllItemRequests = () => {
		for (const controller of abortControllers.value.values()) {
			controller.abort();
		}
		abortControllers.value.clear();
		activeServerSearchKeys.clear();
	};

	const resetRuntimeLoadingState = () => {
		cancelPendingServerSearchFallback();
		cancelBackgroundSync();
		abortAllItemRequests();
		isLoading.value = false;
		cachedPagination.value.loading = false;
		backgroundSyncState.value.running = false;
		resetItemLoadingCoordinator();
	};

	const shouldTryServerSearchFallback = (
		term: string,
		group: string,
		forceServer = false,
	) => {
		if (
			normalizeSearchScope(term).length <
			SERVER_SEARCH_FALLBACK_MIN_LENGTH
		) {
			return false;
		}
		if (isOffline()) {
			return false;
		}
		return forceServer || !isServerSearchMissCached(
			buildServerSearchScopeKey(term, group),
		);
	};

	const searchScopedOfflineCatalog = async (
		term: string,
		group: string,
		limit: number,
	) => {
		if (!shouldPersistItems()) {
			return [];
		}
		const normalizedGroup =
			typeof group === "string" && group.length > 0 ? group : "ALL";
		const stored = await searchStoredItemsCompat({
			search: term,
			itemGroup: normalizedGroup,
			limit,
			offset: 0,
			scope: getStorageScope(),
		});
		return Array.isArray(stored) ? stored : [];
	};

	const scheduleServerSearchFallback = async (
		term: string,
		group: string,
		options: SearchItemsOptions = {},
	): Promise<Item[]> => {
		if (!shouldTryServerSearchFallback(term, group, options.forceServer)) {
			return [];
		}

		cancelPendingServerSearchFallback();
		const fallbackToken = ++serverSearchFallbackToken;
		const normalizedTerm = normalizeSearchScope(term);
		const normalizedGroup =
			typeof group === "string" && group.length > 0 ? group : "ALL";
		const scopeKey = buildServerSearchScopeKey(
			normalizedTerm,
			normalizedGroup,
		);

		return await new Promise<Item[]>((resolve) => {
			resolvePendingServerSearchFallback = resolve;
			serverSearchFallbackTimer = setTimeout(
				async () => {
					serverSearchFallbackTimer = null;
					resolvePendingServerSearchFallback = null;

					if (
						fallbackToken !== serverSearchFallbackToken ||
						normalizeSearchScope(searchTerm.value) !==
							normalizedTerm
					) {
						resolve([]);
						return;
					}

					try {
						const fetched = await loadItems({
							searchValue: term,
							groupFilter: normalizedGroup,
							forceServer: true,
							limit: Math.max(
								1,
								Math.min(
									options.resultLimit || resolvePageSize(),
									resolvePageSize(),
								),
							),
						});

						if (
							fallbackToken !== serverSearchFallbackToken ||
							normalizeSearchScope(searchTerm.value) !==
								normalizedTerm
						) {
							resolve([]);
							return;
						}

						const serverResults = filterItemsByGroup(
							Array.isArray(fetched) ? fetched : [],
							normalizedGroup,
						);
						if (serverResults.length === 0) {
							markServerSearchMiss(scopeKey);
						}
						const mergedResults = mergeItemsPreservingOrder(
							filteredItemsSearchTerm.value === normalizedTerm
								? filteredItems.value
								: [],
							serverResults,
							options.resultLimit || resolvePageSize(),
						);
						setFilteredItems(mergedResults, normalizedTerm);
						resolve(mergedResults);
					} catch (error: any) {
						if (error?.name !== "AbortError") {
							console.error(
								"Server search fallback failed:",
								error,
							);
						}
						if (
							fallbackToken !== serverSearchFallbackToken ||
							normalizeSearchScope(searchTerm.value) !==
								normalizedTerm
						) {
							resolve([]);
							return;
						}
						const offlineResults = await searchScopedOfflineCatalog(
							term,
							normalizedGroup,
							Math.max(
								1,
								options.resultLimit || resolvePageSize(),
							),
						).catch(() => []);
						if (
							fallbackToken !== serverSearchFallbackToken ||
							normalizeSearchScope(searchTerm.value) !==
								normalizedTerm
						) {
							resolve([]);
							return;
						}
						const mergedResults = mergeItemsPreservingOrder(
							filteredItemsSearchTerm.value === normalizedTerm
								? filteredItems.value
								: [],
							offlineResults,
							options.resultLimit || resolvePageSize(),
						);
						setFilteredItems(mergedResults, normalizedTerm);
						resolve(mergedResults);
					}
				},
				Math.max(
					0,
					options.serverFallbackDelayMs ??
						SERVER_SEARCH_FALLBACK_DEBOUNCE_MS,
				),
			);
		});
	};

	const setItems = (
		newItems: Item[],
		options: { append?: boolean; totalCount?: number } = {},
	) => {
		const { append = false, totalCount: totalOverride } = options;
		const normalizedGroup =
			typeof itemGroup.value === "string" && itemGroup.value.length > 0
				? itemGroup.value
				: "ALL";

		if (!append) {
			items.value = Array.isArray(newItems) ? [...newItems] : [];
			resetIndexes();
			updateIndexes(items.value, posProfile.value);
		} else if (Array.isArray(newItems) && newItems.length) {
			const additions: Item[] = [];
			newItems.forEach((item) => {
				if (
					!item ||
					!item.item_code ||
					itemsMap.value.has(item.item_code)
				) {
					return;
				}
				additions.push(item);
			});

			if (additions.length) {
				items.value = [...items.value, ...additions];
				const appendedItems = items.value.slice(-additions.length);
				updateIndexes(appendedItems, posProfile.value);
			}
		}

		if (Number.isFinite(totalOverride)) {
			totalItemCount.value = totalOverride!;
		} else if (!append) {
			totalItemCount.value = items.value.length;
		}

		if (!searchTerm.value) {
			setFilteredItems(filterItemsByGroup(items.value, normalizedGroup));
		}
	};

	// Computed
	const activePriceList = computed(() => {
		return (
			customerPriceList.value ||
			posProfile.value?.selling_price_list ||
			""
		);
	});

	const resolveHotCatalogLimit = () => {
		const rawLimit = Number(posProfile.value?.posa_hot_catalog_limit);
		if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
			return HOT_CATALOG_DEFAULT_LIMIT;
		}
		return Math.max(100, Math.min(rawLimit, HOT_CATALOG_MAX_LIMIT));
	};

	const getProfileItemGroups = () => {
		const groups = posProfile.value?.item_groups;
		if (!Array.isArray(groups)) {
			return [];
		}
		return groups
			.map((entry: any) =>
				typeof entry === "string" ? entry : entry?.item_group,
			)
			.filter(Boolean);
	};

	const buildHotCatalogScopeKey = () =>
		[
			getCacheScope(),
			activePriceList.value || "default",
			customer.value || "no_customer",
			resolveHotCatalogLimit(),
			normalizeBooleanSetting(
				posProfile.value?.posa_fast_counter_positive_stock_only,
			)
				? "positive_stock_only"
				: "all_stock",
			getProfileItemGroups().join(","),
		].join("|");

	const setHotCatalogItems = (nextItems: Item[] = []) => {
		const safeItems = Array.isArray(nextItems) ? nextItems : [];
		hotItems.value = [...safeItems];
		hotSearch.resetIndexes();
		hotSearch.updateIndexes(hotItems.value, posProfile.value);
		hotItemsLoaded.value = true;
	};

	const clearHotCatalog = () => {
		hotItems.value = [];
		hotSearch.resetIndexes();
		hotItemsLoaded.value = false;
		hotCatalogScopeKey.value = "";
	};

	const loadHotCatalog = async (options: { force?: boolean } = {}) => {
		if (!fastCounterEnabled.value || !posProfile.value) {
			clearHotCatalog();
			return [];
		}

		const scopeKey = buildHotCatalogScopeKey();
		if (
			!options.force &&
			hotItemsLoaded.value &&
			hotCatalogScopeKey.value === scopeKey
		) {
			return hotItems.value;
		}

		const requestToken = ++hotCatalogRequestToken;
		hotItemsLoading.value = true;
		try {
			const fetched = await itemService.getHotItemsData({
				pos_profile: JSON.stringify(posProfile.value),
				price_list: activePriceList.value,
				customer: customer.value,
				limit: resolveHotCatalogLimit(),
				days: HOT_CATALOG_DAYS,
				include_description: 0,
				include_image: 0,
				item_groups: getProfileItemGroups(),
			});
			if (requestToken !== hotCatalogRequestToken) {
				return hotItems.value;
			}

			setHotCatalogItems(fetched);
			hotCatalogScopeKey.value = scopeKey;
			if (fetched.length > 0) {
				primeItemDetailsCache(
					fetched,
					posProfile.value,
					activePriceList.value,
				);
			}
			return hotItems.value;
		} catch (error) {
			console.warn("Failed to load fast counter hot catalog:", error);
			return hotItems.value;
		} finally {
			if (requestToken === hotCatalogRequestToken) {
				hotItemsLoading.value = false;
			}
		}
	};

	const isMatchingActiveGroup = (item: Item | undefined | null) => {
		if (!item) {
			return false;
		}
		return filterItemsByGroup([item], itemGroup.value).length > 0;
	};

	const getExactHotItem = (term: string) => {
		if (!fastCounterEnabled.value || !term) {
			return undefined;
		}
		const exact =
			hotSearch.getItemByBarcode(term) || hotSearch.getItemByCode(term);
		return isMatchingActiveGroup(exact) ? exact : undefined;
	};

	const dedupeItems = (itemLists: Item[][], limit = DEFAULT_PAGE_SIZE) => {
		const seen = new Set<string>();
		const merged: Item[] = [];
		itemLists.flat().forEach((item) => {
			if (!item?.item_code || seen.has(item.item_code)) {
				return;
			}
			seen.add(item.item_code);
			merged.push(item);
		});
		return merged.slice(0, limit);
	};

	const searchHotItems = (term: string, limit = resolvePageSize()) => {
		if (
			!fastCounterEnabled.value ||
			!hotItemsLoaded.value ||
			!hotItems.value.length ||
			!term
		) {
			return [];
		}

		const exact = getExactHotItem(term);
		const ranked = hotSearch.performRankedLocalSearch(
			term,
			hotItems.value,
			itemGroup.value,
			limit,
		);
		return exact ? dedupeItems([[exact], ranked], limit) : ranked;
	};

	const hasMoreCachedItems = computed(() => {
		if (!cachedPagination.value.enabled) return false;
		if (cachedPagination.value.loading) return true;
		return cachedPagination.value.offset < cachedPagination.value.total;
	});

	const itemStats = computed(() => {
		const groups = new Set<string>();
		let withImages = 0;
		let withStock = 0;
		let lowStock = 0;

		items.value.forEach((item) => {
			if (item.item_group) {
				groups.add(item.item_group);
			}
			if (item.image) {
				withImages += 1;
			}
			const qty = item.actual_qty || 0;
			if (qty > 0) {
				withStock += 1;
			}
			if (qty < 5) {
				lowStock += 1;
			}
		});

		return {
			total: items.value.length,
			filtered: filteredItems.value.length,
			groups: groups.size,
			withImages,
			withStock,
			lowStock,
		};
	});

	const cacheStats = computed(() => {
		const memCache = cache.value.memory;
		return {
			searchCacheSize: memCache.searchResults.size,
			priceListCacheSize: memCache.priceListData.size,
			itemDetailsCacheSize: memCache.itemDetails.size,
			memoryUsage: getEstimatedMemoryUsage(
				items.value.length,
				memCache.searchResults.size,
				memCache.priceListData.size,
			),
		};
	});

	// Actions
	const initialize = async (
		profile: POSProfile,
		cust: string | null = null,
		priceList: string | null = null,
	) => {
		posProfile.value = profile;
		customer.value = cust;
		customerPriceList.value = priceList;
		lastItemCatalogSyncTime.value = getItemsLastSync();

		await loadItemGroups(posProfile.value);
		await assessCacheHealth();
		if (!shouldPersistItems()) {
			setItems([], { totalCount: 0 });
			itemsLoaded.value = false;
			resetCachedPagination();
			syncBootstrapItemReadiness(0);
		}

		await Promise.allSettled([
			shouldPersistItems() ? loadCachedItems() : Promise.resolve(),
			fastCounterEnabled.value
				? loadHotCatalog({ force: true })
				: Promise.resolve(clearHotCatalog()),
		]);

		const needsInitialServerCatalog =
			!itemsLoaded.value ||
			(!limitSearchEnabled.value && items.value.length === 0);
		if (needsInitialServerCatalog && !isOffline()) {
			await loadItems({ forceServer: false });
		}

		if (
			!isCatalogPersistenceConfigured() &&
			isOfflineStorageReady()
		) {
			void clearStoredItemsCompat(getStorageScope()).catch((error) => {
				console.warn("Failed to remove disabled browser catalog", error);
			});
		}
	};

	const loadCachedItems = async () => {
		try {
			const cachedCount = await getStoredItemsCountByScopeCompat(
				getStorageScope(),
			).catch(() => 0);
			const resolvedCount = Number.isFinite(cachedCount)
				? cachedCount
				: 0;

			totalItemCount.value = resolvedCount;

			if (limitSearchEnabled.value) {
				resetCachedPagination({ enabled: false, total: resolvedCount });
				setItems([], { totalCount: resolvedCount });
				itemsLoaded.value = resolvedCount > 0;
				syncBootstrapItemReadiness(resolvedCount);
				return;
			}

			if (resolvedCount === 0) {
				itemsLoaded.value = false;
				resetCachedPagination();
				syncBootstrapItemReadiness(0);
				return;
			}

			const shouldPaginate = resolvedCount > LARGE_CATALOG_THRESHOLD;
			resetCachedPagination({
				enabled: shouldPaginate,
				total: resolvedCount,
			});

			if (!shouldPaginate) {
				const cachedItems = await getAllStoredItemsCompat(
					getStorageScope(),
				).catch(() => []);
				if (Array.isArray(cachedItems) && cachedItems.length) {
					setItems(cachedItems, { totalCount: resolvedCount });
					cachedPagination.value.offset = cachedItems.length;
					itemsLoaded.value = true;
					syncBootstrapItemReadiness(resolvedCount);
				}
				return;
			}

			const initialItems = await searchStoredItemsCompat({
				search: "",
				itemGroup: itemGroup.value,
				limit: cachedPagination.value.pageSize,
				offset: 0,
				scope: getStorageScope(),
			});

			const safeInitial = Array.isArray(initialItems) ? initialItems : [];
			setItems(safeInitial, { totalCount: resolvedCount });
			cachedPagination.value.offset = safeInitial.length;
			cachedPagination.value.search = "";
			cachedPagination.value.group =
				typeof itemGroup.value === "string" &&
				itemGroup.value.length > 0
					? itemGroup.value
					: "ALL";
			itemsLoaded.value = true;
			syncBootstrapItemReadiness(resolvedCount);
		} catch (error) {
			console.warn("Failed to load cached items:", error);
			itemsLoaded.value = false;
			resetCachedPagination();
			syncBootstrapItemReadiness(0);
		}
	};

	const triggerBackgroundSync = (options: any = {}) => {
		if (!shouldPersistItems()) return;
		if (backgroundSyncState.value.running) return;

		syncBackgroundSyncItems(
			options,
			posProfile.value,
			activePriceList.value,
			getStorageScope(),
			shouldPersistItems(),
			!limitSearchEnabled.value &&
				!normalizeBooleanSetting(
					posProfile.value?.posa_force_server_items,
				),
			resolvePageSize,
			setItems,
			async () => {
				await updateCachedPaginationFromStorage(
					items.value.length,
					totalItemCount,
					posProfile.value,
					shouldUseIndexedSearch(),
					limitSearchEnabled.value,
					getStorageScope(),
				);
			},
			totalItemCount,
			itemsLoaded,
			items,
		)
			.then(() => {
				const lastSync = getItemsLastSync();
				if (lastSync) {
					lastItemCatalogSyncTime.value = lastSync;
				}
			})
			.catch((error) => {
				console.error("Failed to trigger background sync:", error);
			});
	};

	const loadItems = async (options: LoadItemsOptions = {}) => {
		const startTime = performance.now();
		const currentRequestToken = ++requestToken.value;
		let cacheKey: string | null = null;

		try {
			isLoading.value = true;
			performanceMetrics.value.totalRequests++;

			const {
				forceServer,
				searchValue,
				normalizedGroup,
				priceList,
				effectivePriceList,
				isInitialBootstrapRequest,
				args,
			} = buildLoadItemsRequest({
				options,
				posProfile: posProfile.value,
				activePriceList: activePriceList.value,
				customer: customer.value,
				itemCount: items.value.length,
				totalItemCount: totalItemCount.value,
				limitSearchEnabled: limitSearchEnabled.value,
				resolvePageSize,
				resolveLimitSearchSize: () =>
					resolveLimitSearchSize(
						posProfile.value,
						limitSearchEnabled.value,
					),
			});

			cacheKey = generateCacheKey(
				searchValue,
				normalizedGroup,
				priceList,
				getCacheScope(),
			);
			const isServerSearchRequest = forceServer && !!searchValue;

			const shouldForceServerItems = normalizeBooleanSetting(
				posProfile.value?.posa_force_server_items,
			);
			const canReadFromCache =
				!forceServer &&
				!shouldForceServerItems &&
				!limitSearchEnabled.value &&
				!isLargeCatalogWindow();

			if (canReadFromCache) {
				const cachedResult = await getCachedItems(cacheKey);
				if (cachedResult) {
					setItems(cachedResult);
					itemsLoaded.value = true;
					cachedPagination.value.enabled = false;
					cachedPagination.value.offset = cachedResult.length;
					cachedPagination.value.total = cachedResult.length;
					cachedPagination.value.loading = false;
					if (
						!searchValue &&
						normalizedGroup === "ALL" &&
						shouldPersistItems()
					) {
						const storedCount =
							await getStoredItemsCountByScopeCompat(
								getStorageScope(),
							).catch(() => 0);
						if (!storedCount && cachedResult.length) {
							await persistItemsToStorage(
								cachedResult,
								true,
								true,
								getStorageScope(),
								async () => {
									await updateCachedPaginationFromStorage(
										cachedResult.length,
										totalItemCount,
										posProfile.value,
										shouldUseIndexedSearch(),
										limitSearchEnabled.value,
										getStorageScope(),
									);
								},
							);
						}
						if (normalizedGroup === "ALL") {
							syncBootstrapItemReadiness(
								Math.max(
									Number(storedCount || 0),
									cachedResult.length,
								),
							);
						}
					}
					performanceMetrics.value.cachedRequests++;
					updatePerformanceMetrics(startTime);
					return cachedResult;
				}
			}

			const abortController = new AbortController();
			if (isServerSearchRequest) {
				abortActiveServerSearches();
			}
			abortControllers.value.set(cacheKey, abortController);
			if (isServerSearchRequest) {
				activeServerSearchKeys.add(cacheKey);
			}

			if (!args || !posProfile.value) {
				console.warn("Attempted to load items without POS Profile");
				return [];
			}

			const fetchedItems = await itemService.getItemsData(
				args,
				abortController.signal,
			);

			if (requestToken.value !== currentRequestToken) {
				return;
			}

			cachedPagination.value.enabled = false;
			cachedPagination.value.offset = fetchedItems.length;
			cachedPagination.value.total = fetchedItems.length;
			cachedPagination.value.loading = false;
			setItems(fetchedItems);
			itemsLoaded.value = true;
			if (!searchValue && fetchedItems.length > 0) {
				lastItemCatalogSyncTime.value = new Date().toISOString();
			}

			const shouldCacheFetchedItems =
				!limitSearchEnabled.value &&
				!isInitialBootstrapRequest &&
				!shouldForceServerItems;

			if (shouldCacheFetchedItems) {
				await cacheItems(cacheKey, fetchedItems);
			}

			if (
				!searchValue &&
				shouldPersistItems() &&
				normalizedGroup === "ALL"
			) {
				const storedCount = await getStoredItemsCountByScopeCompat(
					getStorageScope(),
				).catch(() => 0);
				syncBootstrapItemReadiness(Number(storedCount || 0));
				triggerBackgroundSync({
					groupFilter: normalizedGroup,
					initialBatch: fetchedItems,
					reset: true,
				});
			}

			if (fetchedItems.length > 0) {
				// `get_items` already returns detail-enriched rows. Seed the offline
				// detail cache from that response and keep the visible-item refresh path
				// as the single place that decides whether a live recheck is still needed.
				primeItemDetailsCache(
					fetchedItems,
					posProfile.value,
					effectivePriceList,
				);
			}

			updatePerformanceMetrics(startTime);
			return fetchedItems;
		} catch (error: any) {
			if (error.name !== "AbortError") {
				console.error("Failed to load items:", error);
				throw error;
			}
		} finally {
			if (requestToken.value === currentRequestToken) {
				isLoading.value = false;
			}
			if (cacheKey) {
				abortControllers.value.delete(cacheKey);
				activeServerSearchKeys.delete(cacheKey);
			}
		}
	};

	const clearLimitSearchResults = ({ preserveItems = false } = {}) => {
		if (!limitSearchEnabled.value) {
			return filteredItems.value;
		}

		cancelBackgroundSync();

		searchTerm.value = "";
		lastSearch.value = "";
		cachedPagination.value.enabled = false;
		cachedPagination.value.offset = 0;
		cachedPagination.value.total = 0;
		cachedPagination.value.loading = false;
		cachedPagination.value.search = "";
		cachedPagination.value.group =
			typeof itemGroup.value === "string" && itemGroup.value.length > 0
				? itemGroup.value
				: "ALL";

		clearSearchCache();
		serverSearchResultCache.clear();
		if (preserveItems) {
			setFilteredItems(filterItemsByGroup(items.value, itemGroup.value));
			return filteredItems.value;
		}

		setItems([], { totalCount: 0 });
		loadProgress.value = 0;
		return filteredItems.value;
	};

	const searchItems = async (
		term: string,
		options: SearchItemsOptions = {},
	) => {
		const requestedSearchScope = normalizeSearchScope(term);
		const resultLimit = Math.max(
			1,
			options.resultLimit || resolvePageSize(),
		);
		const previousTerm = searchTerm.value || "";
		const shouldForceServerSearch = normalizeBooleanSetting(
			posProfile.value?.posa_force_server_items,
		);
		const canRefineSearch =
			!shouldUseIndexedSearch() &&
			term &&
			previousTerm.length > 0 &&
			term.length > previousTerm.length &&
			term.toLowerCase().startsWith(previousTerm.toLowerCase()) &&
			filteredItems.value.length > 0 &&
			filteredItems.value.length < items.value.length;

		searchTerm.value = term;
		lastSearch.value = term;

		if (!term || term.length < 2) {
			cancelPendingServerSearchFallback();
			if (limitSearchEnabled.value) {
				return clearLimitSearchResults({ preserveItems: true });
			}

			if (!cachedPagination.value.enabled) {
				setFilteredItems(
					filterItemsByGroup(items.value, itemGroup.value),
				);
			} else {
				cachedPagination.value.search = "";
				cachedPagination.value.offset = Math.min(
					cachedPagination.value.offset,
					items.value.length,
				);
				setFilteredItems(
					filterItemsByGroup(items.value, itemGroup.value),
				);
			}
			return filteredItems.value;
		}

		if (
			fastCounterEnabled.value &&
			!hotItemsLoaded.value &&
			!hotItemsLoading.value
		) {
			void loadHotCatalog();
		}

		const exactHotItem = getExactHotItem(term);
		const hotSearchResults = searchHotItems(term, resultLimit);
		// When offline, the complete, POS-profile-scoped IndexedDB catalog is
		// authoritative. A hot-catalog suggestion must not hide an exact cached
		// barcode/code match simply because it was rendered first.
		const shouldPreferStoredOfflineCatalog =
			isOffline() && shouldPersistItems();
		if (
			exactHotItem &&
			!shouldPreferStoredOfflineCatalog &&
			!shouldForceServerSearch
		) {
			const exactResults = dedupeItems(
				[[exactHotItem], hotSearchResults],
				resultLimit,
			);
			cancelPendingServerSearchFallback(exactResults);
			setFilteredItems(exactResults, term);
			if (hybridVerifiedEnabled.value && !isOffline()) {
				void scheduleServerSearchFallback(term, itemGroup.value, options);
			}
			performanceMetrics.value.searchHits++;
			return exactResults;
		}

		// A complete browser catalogue is authoritative for exact item-code and
		// barcode lookups even while online. The in-memory hot catalogue is a
		// bounded acceleration layer, so an exact identifier may legitimately be
		// absent from it while remaining available in the scoped IndexedDB
		// generation. Resolve that indexed identifier before scheduling an online
		// server fallback. Non-exact text searches retain the hybrid/server path.
		if (shouldPersistItems() && !shouldForceServerSearch) {
			const normalizedGroup =
				typeof itemGroup.value === "string" &&
				itemGroup.value.length > 0
					? itemGroup.value
					: "ALL";
			const exactStoredItems = await searchExactStoredItemsCompat({
				search: term,
				itemGroup: normalizedGroup,
				scope: getStorageScope(),
			}).catch(() => []);
			if (
				normalizeSearchScope(searchTerm.value) !==
				requestedSearchScope
			) {
				return [];
			}
			if (Array.isArray(exactStoredItems) && exactStoredItems.length > 0) {
				const exactResults = dedupeItems(
					[exactStoredItems, hotSearchResults],
					resultLimit,
				);
				cancelPendingServerSearchFallback(exactResults);
				setFilteredItems(exactResults, term);
				if (hybridVerifiedEnabled.value && !isOffline()) {
					void scheduleServerSearchFallback(term, itemGroup.value, options);
				}
				performanceMetrics.value.searchHits++;
				return exactResults;
			}
		}

		if (limitSearchEnabled.value) {
			const normalizedGroup =
				typeof itemGroup.value === "string" &&
				itemGroup.value.length > 0
					? itemGroup.value
					: "ALL";
			const serverResultCacheKey = buildServerSearchResultCacheKey(
				term,
				normalizedGroup,
				resultLimit,
			);
			const cachedServerResults = shouldForceServerSearch
				? null
				: getCachedServerSearchResult(serverResultCacheKey);
			if (cachedServerResults && !shouldPreferStoredOfflineCatalog) {
				setFilteredItems(cachedServerResults, term);
				if (hybridVerifiedEnabled.value) {
					void scheduleServerSearchFallback(term, normalizedGroup, {
						...options,
						forceServer: true,
					});
				}
				performanceMetrics.value.searchHits++;
				return cachedServerResults;
			}

			if (isOffline()) {
				cancelPendingServerSearchFallback();
				const storedResults = await searchScopedOfflineCatalog(
					term,
					normalizedGroup,
					resultLimit,
				).catch(() => []);
				if (
					normalizeSearchScope(searchTerm.value) !==
					requestedSearchScope
				) {
					return [];
				}
				const offlineResults = dedupeItems(
					[storedResults, hotSearchResults],
					resultLimit,
				);
				setFilteredItems(offlineResults, term);
				performanceMetrics.value.searchHits++;
				return offlineResults;
			}
			if (hotSearchResults.length > 0) {
				setFilteredItems(hotSearchResults, term);
				if (hybridVerifiedEnabled.value) {
					void scheduleServerSearchFallback(term, normalizedGroup, {
						...options,
						forceServer: shouldForceServerSearch,
					});
					performanceMetrics.value.searchHits++;
					return hotSearchResults;
				}
			}
			try {
				const serverResults = await scheduleServerSearchFallback(
					term,
					normalizedGroup,
					{
						...options,
						forceServer: shouldForceServerSearch,
					},
				);
				performanceMetrics.value.searchMisses++;

				if (serverResults.length > 0) {
					setCachedServerSearchResult(
						serverResultCacheKey,
						serverResults,
					);
					return serverResults;
				}
				if (hotSearchResults.length > 0) {
					setFilteredItems(hotSearchResults, term);
				}
				return hotSearchResults;
			} catch (error) {
				console.error("Search failed:", error);
				performanceMetrics.value.searchMisses++;
				return hotSearchResults;
			}
		}

		const cacheKey = `search_${getCacheScope()}_${activePriceList.value || "default"}_${term}_${itemGroup.value}_${resultLimit}`;
		const shouldUseIndexed = shouldUseIndexedSearch();
		const canUseSearchResultCache =
			!shouldUseIndexed &&
			!isLargeCatalogWindow() &&
			!fastCounterEnabled.value;
		const cached = canUseSearchResultCache
			? getCachedSearchResult(cacheKey)
			: null;
		if (cached) {
			setFilteredItems(cached, term);
			if (hybridVerifiedEnabled.value && !isOffline()) {
				void scheduleServerSearchFallback(term, itemGroup.value, options);
			}
			performanceMetrics.value.searchHits++;
			return cached;
		}

		try {
			let searchResults: Item[] = [];

			if (shouldUseIndexed) {
				const normalizedGroup =
					typeof itemGroup.value === "string" &&
					itemGroup.value.length > 0
						? itemGroup.value
						: "ALL";
				const results = await searchStoredItemsCompat({
					search: term,
					itemGroup: normalizedGroup,
					limit: resultLimit,
					offset: 0,
					scope: getStorageScope(),
				});

				searchResults = dedupeItems(
					[Array.isArray(results) ? results : [], hotSearchResults],
					resultLimit,
				);

				if (
					searchResults.length === 0 &&
					shouldTryServerSearchFallback(term, normalizedGroup)
				) {
					searchResults = await scheduleServerSearchFallback(
						term,
						normalizedGroup,
						options,
					);
					if (
						normalizeSearchScope(searchTerm.value) !==
						requestedSearchScope
					) {
						return [];
					}
				} else if (hybridVerifiedEnabled.value && !isOffline()) {
					void scheduleServerSearchFallback(
						term,
						normalizedGroup,
						options,
					);
				} else {
					cancelPendingServerSearchFallback(searchResults);
				}

				cachedPagination.value.search = term;
				cachedPagination.value.offset = searchResults.length;
				cachedPagination.value.total = Math.max(
					cachedPagination.value.total,
					searchResults.length,
				);
			} else {
				const sourceItems = canRefineSearch
					? filteredItems.value
					: items.value;
				const localResults = performRankedLocalSearch(
					term,
					sourceItems,
					itemGroup.value,
					resultLimit,
				);
				searchResults = dedupeItems(
					[hotSearchResults, localResults],
					resultLimit,
				);

				if (searchResults.length === 0 && term.length >= 3) {
					searchResults = await scheduleServerSearchFallback(
						term,
						itemGroup.value,
						options,
					);
					if (
						normalizeSearchScope(searchTerm.value) !==
						requestedSearchScope
					) {
						return [];
					}
				} else if (hybridVerifiedEnabled.value && !isOffline()) {
					void scheduleServerSearchFallback(
						term,
						itemGroup.value,
						options,
					);
				} else {
					cancelPendingServerSearchFallback(searchResults);
				}

				searchResults = filterItemsByGroup(
					searchResults,
					itemGroup.value,
				);
			}

			if (canUseSearchResultCache) {
				setCachedSearchResult(cacheKey, searchResults);
			}

			setFilteredItems(searchResults, term);
			performanceMetrics.value.searchMisses++;

			if (shouldUseIndexed) {
				updateIndexes(searchResults, posProfile.value);
			}

			return searchResults;
		} catch (error) {
			console.error("Search failed:", error);
			performanceMetrics.value.searchMisses++;
			return [];
		}
	};

	const filterByGroup = async (group: string) => {
		itemGroup.value = group;

		if (searchTerm.value) {
			await searchItems(searchTerm.value);
		} else {
			if (cachedPagination.value.enabled && shouldUseIndexedSearch()) {
				await resetCachedItemsForGroup(group);
			} else {
				setFilteredItems(filterItemsByGroup(items.value, group));
			}
		}
	};

	const appendCachedItemsPage = async () => {
		if (limitSearchEnabled.value) return [];
		if (!cachedPagination.value.enabled || cachedPagination.value.loading)
			return [];
		if (searchTerm.value && searchTerm.value.length >= 2) return [];
		if (cachedPagination.value.offset >= cachedPagination.value.total)
			return [];

		cachedPagination.value.loading = true;

		try {
			const nextPage = await searchStoredItemsCompat({
				search: cachedPagination.value.search || "",
				itemGroup: cachedPagination.value.group,
				limit: cachedPagination.value.pageSize,
				offset: cachedPagination.value.offset,
				scope: getStorageScope(),
			});

			const safePage = Array.isArray(nextPage) ? nextPage : [];

			if (safePage.length === 0) {
				cachedPagination.value.offset = cachedPagination.value.total;
				return [];
			}

			setItems(safePage, {
				append: true,
				totalCount: cachedPagination.value.total,
			});
			cachedPagination.value.offset += safePage.length;

			if (safePage.length < cachedPagination.value.pageSize) {
				cachedPagination.value.offset = cachedPagination.value.total;
			}

			return safePage;
		} catch (error) {
			console.warn("Failed to append cached items:", error);
			return [];
		} finally {
			cachedPagination.value.loading = false;
		}
	};

	const resetCachedItemsForGroup = async (group: string) => {
		if (
			limitSearchEnabled.value ||
			!cachedPagination.value.enabled ||
			!shouldUseIndexedSearch()
		) {
			setFilteredItems(filterItemsByGroup(items.value, group));
			return;
		}

		const normalizedGroup =
			typeof group === "string" && group.length > 0 ? group : "ALL";
		cachedPagination.value.group = normalizedGroup;
		cachedPagination.value.offset = 0;
		cachedPagination.value.search = "";

		const firstPage = await searchStoredItemsCompat({
			search: "",
			itemGroup: normalizedGroup,
			limit: cachedPagination.value.pageSize,
			offset: 0,
			scope: getStorageScope(),
		});

		const safePage = Array.isArray(firstPage) ? firstPage : [];
		setItems(safePage, { totalCount: cachedPagination.value.total });
		cachedPagination.value.offset = safePage.length;
	};

	const updatePriceList = async (newPriceList: string) => {
		if (!newPriceList || newPriceList === customerPriceList.value) return;

		customerPriceList.value = newPriceList;

		try {
			const cacheKey = `price_list_${getCacheScope()}_${newPriceList}`;
			let priceData = getCachedPriceList(cacheKey);

			if (!priceData) {
				priceData = await getCachedPriceListItemsCompat(newPriceList);
				if (priceData && priceData.length > 0) {
					setCachedPriceList(cacheKey, priceData);
				}
			}

			if (priceData && priceData.length > 0) {
				applyPriceListToItems(priceData);
			} else {
				await loadItems({
					forceServer: true,
					priceList: newPriceList,
					limit: resolvePageSize(),
				});
			}
			if (fastCounterEnabled.value) {
				await loadHotCatalog({ force: true });
			}
		} catch (error) {
			console.error("Failed to update price list:", error);
		}
	};

	const applyPriceListToItems = (priceListItems: any[]) => {
		const priceMap = new Map();
		priceListItems.forEach((item) => {
			priceMap.set(item.item_code, item);
		});

		items.value.forEach((item) => {
			const priceItem = priceMap.get(item.item_code);
			if (priceItem) {
				const nextRate =
					priceItem.price_list_rate || priceItem.rate || 0;
				const nextCurrency =
					priceItem.currency ||
					item.original_currency ||
					item.currency ||
					posProfile.value?.currency;

				item.rate = nextRate;
				item.price_list_rate = nextRate;
				item.original_rate = nextRate;
				item.original_currency = nextCurrency;
				item.currency = nextCurrency;
			}
		});
		if (hotItems.value.length > 0) {
			hotItems.value.forEach((item) => {
				const priceItem = priceMap.get(item.item_code);
				if (!priceItem) {
					return;
				}
				const nextRate =
					priceItem.price_list_rate || priceItem.rate || 0;
				const nextCurrency =
					priceItem.currency ||
					item.original_currency ||
					item.currency ||
					posProfile.value?.currency;

				item.rate = nextRate;
				item.price_list_rate = nextRate;
				item.original_rate = nextRate;
				item.original_currency = nextCurrency;
				item.currency = nextCurrency;
			});
			hotItems.value = [...hotItems.value];
			hotSearch.resetIndexes();
			hotSearch.updateIndexes(hotItems.value, posProfile.value);
		}
		clearSearchCache();

		if (searchTerm.value) {
			setFilteredItems(
				performLocalSearch(
					searchTerm.value,
					items.value,
					itemGroup.value,
				),
				searchTerm.value,
			);
		} else {
			setFilteredItems(filterItemsByGroup(items.value, itemGroup.value));
		}
	};

	const refreshItems = async () => {
		resetRuntimeLoadingState();
		await clearAllCaches();
		itemsLoaded.value = false;
		resetCachedPagination();
		await loadItems({ forceServer: true });
		if (fastCounterEnabled.value) {
			await loadHotCatalog({ force: true });
		} else {
			clearHotCatalog();
		}
	};

	const recoverItemCatalog = async (
		options: {
			reason?: string;
			preserveSearch?: boolean;
			allowCooldown?: boolean;
		} = {},
	) => {
		const now = Date.now();
		if (
			options.allowCooldown &&
			lastRecoveryAt &&
			now - lastRecoveryAt < RESUME_RECOVERY_COOLDOWN_MS
		) {
			return items.value;
		}
		lastRecoveryAt = now;

		const activeSearch = options.preserveSearch ? searchTerm.value : "";
		const activeGroup = itemGroup.value || "ALL";
		console.info("[POSA][Items] recovering item catalog", {
			reason: options.reason || "manual",
			search: activeSearch,
			group: activeGroup,
		});

		resetRuntimeLoadingState();
		clearSearchCache();
		await assessCacheHealth().catch((error) => {
			console.warn("Failed to assess item cache during recovery:", error);
		});

		try {
			const fetchedItems = await loadItems({
				forceServer: true,
				searchValue: activeSearch,
				groupFilter: activeGroup,
			});
			if (fastCounterEnabled.value) {
				await loadHotCatalog({ force: true });
			} else {
				clearHotCatalog();
			}
			return Array.isArray(fetchedItems) ? fetchedItems : items.value;
		} catch (error) {
			console.error("[POSA][Items] item catalog recovery failed:", error);
			itemsLoaded.value = items.value.length > 0;
			if (!activeSearch && items.value.length === 0) {
				await loadCachedItems();
			}
			throw error;
		}
	};

	const recoverItemCatalogIfUnhealthy = async (reason = "resume") => {
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			return items.value;
		}

		const hasVisibleItems =
			items.value.length > 0 || filteredItems.value.length > 0;
		const expectsBrowseCatalog = !limitSearchEnabled.value;
		const hasStuckLoading =
			(isLoading.value || isBackgroundLoading.value) && !hasVisibleItems;
		const hasEmptyLoadedCatalog =
			expectsBrowseCatalog &&
			itemsLoaded.value &&
			items.value.length === 0 &&
			totalItemCount.value === 0;
		const hasMissingCache =
			expectsBrowseCatalog &&
			!hasVisibleItems &&
			(cacheHealth.value.items === "missing" ||
				cacheHealth.value.items === "error");

		if (!hasStuckLoading && !hasEmptyLoadedCatalog && !hasMissingCache) {
			return items.value;
		}

		return await recoverItemCatalog({
			reason,
			preserveSearch: true,
			allowCooldown: true,
		});
	};

	const addScannedItem = async (barcode: string) => {
		let item = getItemByBarcode(barcode) || getExactHotItem(barcode);
		if (item) return item;

		try {
			const newItem: any = await itemService.getItemsFromBarcodeData({
				selling_price_list: activePriceList.value,
				currency: posProfile.value?.currency || "",
				barcode: barcode,
			});

			if (newItem) {
				if (
					newItem.scale_qty !== undefined &&
					newItem.scale_qty !== null
				) {
					const parsedQty = parseFloat(newItem.scale_qty);
					if (!Number.isNaN(parsedQty)) {
						newItem._scale_qty = parsedQty;
					}
				}

				if (
					newItem.scale_price !== undefined &&
					newItem.scale_price !== null
				) {
					const parsedPrice = parseFloat(newItem.scale_price);
					if (!Number.isNaN(parsedPrice)) {
						newItem._scale_price = parsedPrice;
					}
				}

				items.value.push(newItem);
				updateIndexes([newItem], posProfile.value);
				if (fastCounterEnabled.value) {
					setHotCatalogItems(
						dedupeItems(
							[[newItem], hotItems.value],
							resolveHotCatalogLimit(),
						),
					);
				}

				if (searchTerm.value) {
					await searchItems(searchTerm.value);
				} else {
					setFilteredItems(
						filterItemsByGroup(items.value, itemGroup.value),
					);
				}

				clearSearchCache();
				return newItem as Item;
			}
			return null;
		} catch (error) {
			console.error("Failed to fetch item by barcode:", error);
			return null;
		}
	};

	const upsertCatalogItem = (updatedItem: Item | null | undefined) => {
		if (!updatedItem?.item_code) {
			return;
		}

		const mergeIntoCollection = (collection: Item[]) => {
			const index = collection.findIndex(
				(item) => item?.item_code === updatedItem.item_code,
			);
			if (index >= 0) {
				collection[index] = { ...collection[index], ...updatedItem };
			} else {
				collection.unshift(updatedItem);
			}
		};

		mergeIntoCollection(items.value);
		mergeIntoCollection(filteredItems.value);
		if (fastCounterEnabled.value) {
			setHotCatalogItems(
				dedupeItems(
					[[updatedItem], hotItems.value],
					resolveHotCatalogLimit(),
				),
			);
		}
		updateIndexes(items.value, posProfile.value);
		clearSearchCache();
	};

	const refreshModifiedItems = async (
		priceListOverride: string | null = null,
	) => {
		if (!itemsLoaded.value) return { size: 0, count: 0, items: [] };
		const resolvedPriceList =
			typeof priceListOverride === "string" &&
			priceListOverride.trim().length > 0
				? priceListOverride.trim()
				: activePriceList.value;

		return await syncRefreshModifiedItems(
			posProfile.value,
			resolvedPriceList,
			customer.value,
			getStorageScope(),
			(updates) => updateItemsInPlace(updates),
			itemsMap.value,
		);
	};

	const updateItemsInPlace = (updates: Item[]) => {
		if (!Array.isArray(updates) || updates.length === 0) {
			return;
		}

		const additions: Item[] = [];
		const touchedItems: Item[] = [];
		const canonicalItemsByCode = new Map<string, Item>();
		items.value.forEach((item) => {
			if (item?.item_code) {
				canonicalItemsByCode.set(item.item_code, item);
			}
		});

		updates.forEach((update) => {
			if (!update?.item_code) {
				return;
			}

			const existing = canonicalItemsByCode.get(update.item_code);
			if (existing) {
				Object.assign(existing, update);
				const syncedRate = update.price_list_rate ?? update.rate;
				if (syncedRate !== undefined && syncedRate !== null) {
					existing.original_rate = syncedRate as any;
				}
				if (update.currency) {
					existing.original_currency = update.currency as any;
				}
				touchedItems.push(existing);
			} else {
				const syncedRate = update.price_list_rate ?? update.rate;
				if (
					syncedRate !== undefined &&
					syncedRate !== null &&
					update.original_rate === undefined
				) {
					(update as any).original_rate = syncedRate;
				}
				if (update.currency && update.original_currency === undefined) {
					(update as any).original_currency = update.currency;
				}
				additions.push(update);
			}
		});

		if (additions.length > 0) {
			items.value = [...items.value, ...additions];
			const appendedItems = items.value.slice(-additions.length);
			updateIndexes(appendedItems, posProfile.value);
		}

		if (touchedItems.length > 0) {
			// Force a shallow array refresh so virtualized tables/cards re-render
			// even when rows are updated in-place.
			items.value = [...items.value];
			updateIndexes(touchedItems, posProfile.value);
		}

		if (fastCounterEnabled.value && hotItems.value.length > 0) {
			const updatesByCode = new Map(
				updates
					.filter((update) => update?.item_code)
					.map((update) => [update.item_code, update]),
			);
			let touchedHotItems = false;
			hotItems.value.forEach((item) => {
				const update = updatesByCode.get(item.item_code);
				if (!update) {
					return;
				}
				Object.assign(item, update);
				touchedHotItems = true;
			});
			if (touchedHotItems) {
				hotItems.value = [...hotItems.value];
				hotSearch.resetIndexes();
				hotSearch.updateIndexes(hotItems.value, posProfile.value);
			}
		}

		clearSearchCache();
		if (searchTerm.value) {
			setFilteredItems(
				performLocalSearch(
					searchTerm.value,
					items.value,
					itemGroup.value,
				),
				searchTerm.value,
			);
		} else {
			setFilteredItems(filterItemsByGroup(items.value, itemGroup.value));
		}
	};

	// Watchers
	watch(customerPriceList, (newPriceList) => {
		if (newPriceList && itemsLoaded.value) {
			updatePriceList(newPriceList);
		}
	});

	return {
		// State
		items,
		filteredItems,
		filteredItemsSearchTerm,
		itemsMap,
		barcodeIndex,
		itemGroups,
		isLoading,
		isBackgroundLoading,
		loadProgress,
		syncedItemsCount,
		totalItemCount,
		itemsLoaded,
		searchTerm,
		itemGroup,
		lastSearch,
		lastItemCatalogSyncTime,
		lastLiveVerificationAt,
		liveVerificationInFlight,
		posProfile,
		customer,
		customerPriceList,
		hotItems,
		hotItemsLoaded,
		hotItemsLoading,
		cacheHealth,
		performanceMetrics,
		cachedPagination,
		hasMoreCachedItems,

		// Computed
		activePriceList,
		fastCounterEnabled,
		hybridVerifiedEnabled,
		itemStats,
		cacheStats,

		// Actions
		initialize,
		loadItems,
		loadItemGroups,
		loadCachedItems,
		searchItems,
		filterByGroup,
		updatePriceList,
		refreshItems,
		recoverItemCatalog,
		recoverItemCatalogIfUnhealthy,
		loadHotCatalog,
		appendCachedItemsPage,
		resetCachedItemsForGroup,
		backgroundSyncItems: triggerBackgroundSync, // mapped
		getItemByCode,
		getItemByBarcode,
		addScannedItem,
		upsertCatalogItem,
		refreshModifiedItems,
		hydrateLiveItems,
		clearLimitSearchResults,
		clearAllCaches,
		clearSearchCache,
		assessCacheHealth,
	};
});

export default useItemsStore;
