export const INVOICE_SHORTCUT_LISTENER_OPTIONS = true;

type ShortcutHandler = (event: KeyboardEvent) => void;

const isAltModifierKey = (event: KeyboardEvent) =>
	event.key === "Alt" ||
	event.code === "AltLeft" ||
	event.code === "AltRight";

const isAltShortcutEvent = (event: KeyboardEvent) =>
	event.altKey &&
	!event.ctrlKey &&
	!event.metaKey &&
	!isAltModifierKey(event);

const getShortcutKey = (event: KeyboardEvent) => event.code || event.key;

const isImeEvent = (event: KeyboardEvent) =>
	event.isComposing || event.key === "Process" || event.keyCode === 229;

export const createInvoiceShortcutListeners = (handler: ShortcutHandler) => {
	const handledOnKeydown = new Set<string>();

	const onKeydown = (event: KeyboardEvent) => {
		if (isImeEvent(event)) {
			return;
		}
		handler(event);
		if (event.defaultPrevented && isAltShortcutEvent(event)) {
			handledOnKeydown.add(getShortcutKey(event));
		}
	};

	const onKeyup = (event: KeyboardEvent) => {
		if (isImeEvent(event)) {
			return;
		}
		if (isAltModifierKey(event)) {
			handledOnKeydown.clear();
			return;
		}

		if (!isAltShortcutEvent(event)) {
			return;
		}

		const shortcutKey = getShortcutKey(event);
		if (handledOnKeydown.delete(shortcutKey)) {
			return;
		}

		handler(event);
	};

	return {
		onKeydown,
		onKeyup,
	};
};

export const registerInvoiceShortcutListener = (
	target: Pick<Document, "addEventListener">,
	listeners: ReturnType<typeof createInvoiceShortcutListeners>,
) => {
	target.addEventListener(
		"keydown",
		listeners.onKeydown,
		INVOICE_SHORTCUT_LISTENER_OPTIONS,
	);
	target.addEventListener(
		"keyup",
		listeners.onKeyup,
		INVOICE_SHORTCUT_LISTENER_OPTIONS,
	);
};

export const unregisterInvoiceShortcutListener = (
	target: Pick<Document, "removeEventListener">,
	listeners: ReturnType<typeof createInvoiceShortcutListeners>,
) => {
	target.removeEventListener(
		"keydown",
		listeners.onKeydown,
		INVOICE_SHORTCUT_LISTENER_OPTIONS,
	);
	target.removeEventListener(
		"keyup",
		listeners.onKeyup,
		INVOICE_SHORTCUT_LISTENER_OPTIONS,
	);
};
