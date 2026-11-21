/** maker 2026-11-20 "Tab on next fees": anon launch gas goes on a private tab, paid down a step at a time. */
import { describe, expect, it } from "vitest";
import { addToTab, payTab, tabMax, tabOwed, tabSlice, tabStep } from "../lib/server/launchTab";
import type { Kv } from "../lib/server/kv";

function fakeKv() {
  const m = new Map<string, string>();
  const s = {
    get: async (k: string) => m.get(k) ?? null,
    del: async (...ks: string[]) => { ks.forEach((k) => m.delete(k)); },
    incrByEx: async (k: string, by: number) => { const n = Number(m.get(k) ?? 0) + by; m.set(k, String(n)); return n; },
  };
  return { s: s as unknown as Kv, m };
}
const W = "0x929D22560c48d3240a7e35559810d58f3d2692aD";

describe("launch tab", () => {
  it("adds a launch, slices at most one step, pays down to zero and clears", async () => {
    const { s, m } = fakeKv();
    await addToTab(W, 70_000n, s);
    expect(await tabOwed(W.toLowerCase(), s)).toBe(70_000n);
    expect(await tabSlice(W, s)).toBe(tabStep());
    let n = 0;
    while ((await tabOwed(W, s)) > 0n && n++ < 10) await payTab(W, await tabSlice(W, s), s);
    expect(await tabOwed(W, s)).toBe(0n);
    expect(m.size).toBe(0);
    expect(n).toBe(Math.ceil(70_000 / Number(tabStep())));
  });
  it("cap allows about three launches before refusing", () => {
    expect(tabMax() / 70_000n).toBe(3n);
  });
});
