/**
 * Module-private vault for redacted cross-cashier recovery rows.
 *
 * A Vue `<script setup>` binding is visible to component devtools even when it
 * is not reactive. Keep the full row outside component setup entirely; the
 * visible table receives only an opaque handle and can never render the row's
 * customer, amount, request identity, invoice, or data fields.
 */

type ProtectedRecoveryEntry = Record<string, any>;

const entries = new Map<string, ProtectedRecoveryEntry>();
let nextHandle = 0;

export function clearProtectedRecoveryVault() {
	entries.clear();
}

export function storeProtectedRecoveryEntry(entry: ProtectedRecoveryEntry) {
	const handle = `protected-${++nextHandle}`;
	entries.set(handle, entry);
	return handle;
}

export function resolveProtectedRecoveryEntry(handle: unknown) {
	return entries.get(String(handle || "")) || null;
}
