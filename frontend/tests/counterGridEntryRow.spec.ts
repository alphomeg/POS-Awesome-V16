// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

describe("CounterGridEntryRow", () => {
	it("edits inline, submits the typed query, and supports reverse navigation", async () => {
		vi.stubGlobal("__", (value: string) => value);
		const { default: CounterGridEntryRow } = await import(
			"../src/posapp/components/pos/invoice/CounterGridEntryRow.vue"
		);
		const wrapper = mount(
			{
				components: { CounterGridEntryRow },
				data: () => ({
					query: "",
					submitted: "",
					navigationMethod: "",
					forwardNavigationCount: 0,
					payNavigationCount: 0,
				}),
				template: `
				<table><tbody>
					<CounterGridEntryRow
						v-model="query"
						:columns="[{ key: 'data-table-expand' }, { key: 'item_name' }, { key: 'qty' }]"
						@submit="submitted = $event"
						@navigate-back="navigationMethod = $event"
						@navigate-forward="forwardNavigationCount += 1"
						@navigate-pay="payNavigationCount += 1"
					/>
				</tbody></table>
			`,
			},
			{
				global: {
					stubs: {
						VIcon: { template: "<span />" },
					},
				},
			},
		);
		const input = wrapper.get<HTMLInputElement>(
			'[data-testid="counter-grid-item-entry"]',
		);
		await input.setValue("panadol");
		expect((wrapper.vm as any).query).toBe("panadol");

		await input.trigger("keydown", { key: "Enter" });
		expect((wrapper.vm as any).submitted).toBe("panadol");

		await input.trigger("keydown", { key: "Tab", shiftKey: true });
		expect((wrapper.vm as any).navigationMethod).toBe("shift-tab");

		await input.trigger("keydown", { key: "ArrowUp" });
		expect((wrapper.vm as any).navigationMethod).toBe("arrow-up");

		const forwardEvent = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			bubbles: true,
			cancelable: true,
		});
		input.element.dispatchEvent(forwardEvent);
		await wrapper.vm.$nextTick();
		expect((wrapper.vm as any).forwardNavigationCount).toBe(1);
		expect((wrapper.vm as any).query).toBe("panadol");
		expect(forwardEvent.defaultPrevented).toBe(true);

		const modifiedForwardEvent = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		input.element.dispatchEvent(modifiedForwardEvent);
		await wrapper.vm.$nextTick();
		expect((wrapper.vm as any).forwardNavigationCount).toBe(1);
		expect(modifiedForwardEvent.defaultPrevented).toBe(false);

		await input.setValue("");
		const payEvent = new KeyboardEvent("keydown", {
			key: "ArrowLeft",
			bubbles: true,
			cancelable: true,
		});
		input.element.dispatchEvent(payEvent);
		await wrapper.vm.$nextTick();
		expect((wrapper.vm as any).payNavigationCount).toBe(1);
		expect(payEvent.defaultPrevented).toBe(true);

		await input.setValue("panadol");
		const caretEvent = new KeyboardEvent("keydown", {
			key: "ArrowLeft",
			bubbles: true,
			cancelable: true,
		});
		input.element.dispatchEvent(caretEvent);
		await wrapper.vm.$nextTick();
		expect((wrapper.vm as any).payNavigationCount).toBe(1);
		expect(caretEvent.defaultPrevented).toBe(false);
	});

	it("does not open an unscoped search for an empty value", async () => {
		vi.stubGlobal("__", (value: string) => value);
		const { default: CounterGridEntryRow } = await import(
			"../src/posapp/components/pos/invoice/CounterGridEntryRow.vue"
		);
		const wrapper = mount(
			{
				components: { CounterGridEntryRow },
				data: () => ({ query: "", submitted: "" }),
				template: `
				<table><tbody>
					<CounterGridEntryRow
						v-model="query"
						:columns="[{ key: 'item_name' }]"
						@submit="submitted = $event"
					/>
				</tbody></table>
			`,
			},
			{
				global: { stubs: { VIcon: { template: "<span />" } } },
			},
		);
		await wrapper
			.get('[data-testid="counter-grid-item-entry"]')
			.trigger("keydown", {
				key: "Enter",
			});
		expect((wrapper.vm as any).submitted).toBe("");
	});
});
