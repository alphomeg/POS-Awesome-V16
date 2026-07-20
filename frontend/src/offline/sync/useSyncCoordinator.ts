import { SyncCoordinator } from "./SyncCoordinator";

let coordinator: SyncCoordinator | null = null;

export function useSyncCoordinator() {
	if (!coordinator) {
		throw new Error("The POS sync coordinator has not been configured");
	}
	return coordinator;
}

export function setSyncCoordinator(nextCoordinator: SyncCoordinator) {
	coordinator = nextCoordinator;
	return coordinator;
}

export function resetSyncCoordinatorForTests() {
	coordinator = null;
}
