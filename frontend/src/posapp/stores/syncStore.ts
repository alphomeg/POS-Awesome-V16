/**
 * Lightweight Pinia store for durable invoice recovery status and actions.
 *
 * This store exposes the unique pending count across the outbox and compatibility
 * queue. Manual recovery joins the same configured `SyncCoordinator` used by
 * reconnect and timer triggers.
 *
 * **`syncPendingInvoices()`**
 * Reads the pending count, shows a warning toast if any are queued, and then
 * joins the coordinator's user-action trigger. The sync is skipped when
 * `isOffline()` returns true. On completion it shows success/draft toasts and
 * refreshes the count. Errors are caught and logged; the count is always updated.
 *
 * **Options API style**
 * This store uses the Options API form of `defineStore` (with `state` /
 * `actions`) rather than the Setup API used by newer stores in this codebase.
 */
import { defineStore } from "pinia";
import {
	consumeLastSyncTotals,
	getLastSyncTotals,
	getPendingInvoiceRecoveryCount,
	isOffline,
} from "../../offline/index";
import { useSyncCoordinator } from "../../offline/sync/useSyncCoordinator";
import { useToastStore } from "./toastStore.js";

export const useSyncStore = defineStore("sync", {
	state: () => ({
		pendingInvoicesCount: 0,
	}),
	actions: {
		async updatePendingCount() {
			try {
				this.pendingInvoicesCount =
					await getPendingInvoiceRecoveryCount();
			} catch (error) {
				console.error("Failed to update pending invoices count", error);
			}
			return this.pendingInvoicesCount;
		},
		setPendingCount(count: number) {
			this.pendingInvoicesCount = count;
		},
		async syncPendingInvoices(
			options: {
				showToasts?: boolean;
				transactionalOnly?: boolean;
			} = {},
		) {
			const toastStore = useToastStore();
			const pending = await this.updatePendingCount();
			const showToasts = options.showToasts !== false;

			if (pending && showToasts) {
				toastStore.show({
					title: `${pending} invoice${pending > 1 ? "s" : ""} pending for sync`,
					color: "warning",
				});
			}

			if (isOffline()) {
				return getLastSyncTotals();
			}

			try {
				const coordinator = useSyncCoordinator();
				if (options.transactionalOnly) {
					await coordinator.runTransactionalTrigger("user_action");
				} else {
					await coordinator.runTrigger("user_action");
				}
				const result = consumeLastSyncTotals();
				if (showToasts && result && (result.synced || result.drafted)) {
					if (result.synced) {
						toastStore.show({
							title: `${result.synced} offline invoice${result.synced > 1 ? "s" : ""} synced`,
							color: "success",
						});
					}
					if (result.drafted) {
						toastStore.show({
							title: `${result.drafted} offline invoice${result.drafted > 1 ? "s" : ""} saved as draft`,
							color: "warning",
						});
					}
				}
				return result;
			} catch (error) {
				console.error("Sync failed", error);
				return getLastSyncTotals();
			} finally {
				await this.updatePendingCount();
			}
		},
	},
});
