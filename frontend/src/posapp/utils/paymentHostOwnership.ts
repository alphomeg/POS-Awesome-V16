export type CheckoutPaymentHostOwner = "dialog" | "inline" | "shortcut";

interface PaymentDialogOwnershipInput {
	checkoutLocked: boolean;
	owner: CheckoutPaymentHostOwner | null | undefined;
	windowWidth: number;
}

/**
 * Keeps the Payments component that started checkout mounted until the shared
 * lock is released. A durable recovery restored without a live owner fails
 * closed to the visible, persistent dialog host.
 */
export function shouldUsePaymentDialog({
	checkoutLocked,
	owner,
	windowWidth,
}: PaymentDialogOwnershipInput) {
	if (checkoutLocked) {
		return owner !== "inline" && owner !== "shortcut";
	}
	return Number(windowWidth || 0) >= 992;
}
