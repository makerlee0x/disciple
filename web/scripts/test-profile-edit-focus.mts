// Edit profile: typing several characters in a row keeps focus and value (lee, 2026-10-24: "the username and bio
// doesn't let you type more than one character at a time"). Renders the real EditProfileSheet in happy-dom with React.
//   pnpm test:profile-edit-focus
// Cause was Sheet's effect depending on the inline onClose (new each render): every keystroke re-ran it, its cleanup
// focused the opener and its re-run focused the first button. Typing goes through React's onChange with a re-render
// per key, like a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "https://disciple.test/profile" });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Element",
  "Event", "KeyboardEvent", "MouseEvent", "FocusEvent", "InputEvent", "localStorage", "getComputedStyle", "MutationObserver"] as const) {
  try { g[k] = (win as unknown as Record<string, unknown>)[k]; } catch { /* read-only global (navigator on new Node): skip */ }
}
if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;
// No network in the test: username status / availability answer locally.
g.fetch = async (u: string) => new Response(JSON.stringify(String(u).includes("address=") ? { username: null, nextAllowedAt: null } : { available: true }),
  { headers: { "content-type": "application/json" } });

const React = await import("react");
const { act } = React as unknown as { act: (f: () => unknown) => Promise<void> };
const { createRoot } = await import("react-dom/client");
const { default: EditProfileSheet } = await import("../components/profile/EditProfileSheet.tsx");
const { EMPTY_META } = await import("../lib/profileMeta.ts");

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Mount the sheet like ProfileDashboard does: a parent that re-renders and passes an inline onClose. */
async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const opener = document.createElement("button");
  opener.textContent = "Edit";
  document.body.appendChild(opener);
  opener.focus();
  const root = createRoot(host as unknown as Element);
  function Parent() {
    const [, bump] = React.useState(0);
    return React.createElement(EditProfileSheet, { open: true, wallet: "0x" + "1".repeat(40), meta: EMPTY_META, focus: null,
      onClose: () => bump((n) => n + 1) });
  }
  await act(async () => { root.render(React.createElement(Parent)); });
  await act(async () => { await tick(); });
  return { root, host };
}

/** Type like a user: focus once, then one key at a time (each fires React's onChange and re-renders). */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => { el.focus(); await tick(); });
  for (const ch of text) {
    assert.equal(document.activeElement, el, `focus still in the field before typing "${ch}"`);
    const proto = el instanceof (win.HTMLTextAreaElement as unknown as typeof HTMLTextAreaElement) ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    await act(async () => {
      setter.call(el, el.value + ch);
      el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      await tick();
    });
  }
}

test("username: several keystrokes in a row keep focus and value", async () => {
  const { root, host } = await mount();
  const input = host.querySelector<HTMLInputElement>("input.pf-input:not([type])")!;
  assert.ok(input, "username input rendered");
  await typeInto(input, "rocketman");
  assert.equal(document.activeElement, input, "focus stays in the username field");
  assert.equal(input.value, "rocketman");
  await act(async () => { root.unmount(); });
});

test("bio: several keystrokes in a row keep focus and value", async () => {
  const { root, host } = await mount();
  const bio = host.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.ok(bio, "bio textarea rendered");
  await typeInto(bio, "gm frens");
  assert.equal(document.activeElement, bio, "focus stays in the bio field");
  assert.equal(bio.value, "gm frens");
  await act(async () => { root.unmount(); });
});

test("username under 3 characters: inline message and Save disabled", async () => {
  const { root, host } = await mount();
  const input = host.querySelector<HTMLInputElement>("input.pf-input:not([type])")!;
  await typeInto(input, "ab");
  await act(async () => { await tick(); });
  const status = host.querySelector('[data-testid="username-status"]');
  assert.equal(status?.textContent, "Usernames need at least 3 characters.");
  const save = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(save.disabled, true, "Save disabled for a 2-character name");
  await typeInto(input, "c");
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); }); // availability check debounce
  assert.equal(save.disabled, false, "Save enabled once the name has 3 characters");
  await act(async () => { root.unmount(); });
});

test.after(() => { void win.happyDOM.close(); });
