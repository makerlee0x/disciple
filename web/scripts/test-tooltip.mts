// Shared Tooltip (components/ui/Tooltip): hover + keyboard focus on desktop, never on mouse click; tap / tap-outside on touch.
//   pnpm test:tooltip
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "https://disciple.test/profile", width: 390, height: 800 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent",
  "FocusEvent", "getComputedStyle", "MutationObserver"] as const) {
  try { g[k] = (win as unknown as Record<string, unknown>)[k]; } catch { /* read-only global */ }
}
if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
g.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React as unknown as { act: (f: () => unknown) => Promise<void> };
const { createRoot } = await import("react-dom/client");
const { default: Tooltip } = await import("../components/ui/Tooltip.tsx");

const tip = () => document.querySelector("[role=tooltip]");
const ptr = (el: Element, type: string, pointerType: string) =>
  el.dispatchEvent(new (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent(type, { bubbles: true, pointerType } as PointerEventInit));

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(() => root.render(React.createElement("div", null,
    React.createElement(Tooltip, { content: "Avg hold ≥ 24h" }, React.createElement("span", { "data-t": "1" }, "Believer")),
    React.createElement("p", { "data-o": "1" }, "outside"))));
  const t = host.querySelector("[data-t]") as HTMLElement;
  return { t, outside: host.querySelector("[data-o]") as HTMLElement, done: async () => { await act(() => root.unmount()); host.remove(); } };
}

test("mouse: hover opens, leave closes, click alone never opens", async () => {
  const { t, done } = await mount();
  assert.equal(t.getAttribute("title"), null, "no native title tooltip");
  await act(async () => { ptr(t, "pointerover", "mouse"); });
  assert.ok(tip(), "open on hover"); assert.equal(tip()!.textContent, "Avg hold ≥ 24h");
  assert.equal(t.getAttribute("aria-describedby"), tip()!.id);
  await act(async () => { ptr(t, "pointerout", "mouse"); });
  assert.equal(tip(), null, "closed on leave");
  await act(async () => { ptr(t, "pointerdown", "mouse"); t.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  assert.equal(tip(), null, "click does not toggle");
  await done();
});

test("keyboard: focus opens, Escape and blur close", async () => {
  const { t, done } = await mount();
  assert.equal(t.tabIndex, 0, "focusable");
  await act(async () => { t.focus(); });
  assert.ok(tip(), "open on focus");
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  assert.equal(tip(), null, "Esc closes");
  await act(async () => { t.blur(); t.focus(); });
  assert.ok(tip());
  await act(async () => { t.blur(); });
  assert.equal(tip(), null, "blur closes");
  await done();
});

test("touch: tap shows, tap again hides, tap outside hides", async () => {
  const { t, outside, done } = await mount();
  const tap = async (el: Element) => act(async () => { ptr(el, "pointerdown", "touch"); el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await tap(t); assert.ok(tip(), "tap opens");
  await tap(t); assert.equal(tip(), null, "second tap closes");
  await tap(t); assert.ok(tip());
  await act(async () => { ptr(outside, "pointerdown", "touch"); });
  assert.equal(tip(), null, "tap outside closes");
  await done();
});
