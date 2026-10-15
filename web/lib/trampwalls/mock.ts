/** In-browser mock TrampWallAdapter (localStorage). Replace with FLOW's viem adapter. */
import type { Address } from "../protocol";
import { computePreview, pointsFor, type TrampWall, type TrampWallAdapter, type TrampWallEvent } from "./adapter";

const KEY = "disciple.tw.v1";
export const MOCK_ME: Address = "0x000000000000000000000000000000000000beef";
const subs = new Set<(e: TrampWallEvent) => void>();

type Stored = Omit<TrampWall, "amount"> & { amount: string };
function load(): TrampWall[] {
  if (typeof window === "undefined") return [];
  try { return (JSON.parse(localStorage.getItem(KEY) || "[]") as Stored[]).map((s) => ({ ...s, amount: BigInt(s.amount) })); } catch { return []; }
}
function save(all: TrampWall[]) {
  localStorage.setItem(KEY, JSON.stringify(all.map((t) => ({ ...t, amount: t.amount.toString() }))));
}
function emit(e: TrampWallEvent) { subs.forEach((f) => f(e)); }

/** Seed crowd tramps/walls around the price so the chart isn't empty. */
function seed(token: Address, cur: number): TrampWall[] {
  const rnd = (i: number) => Math.sin(i * 9301 + cur) * 0.5 + 0.5;
  return [-6, -11, -18, 5, 9, 15].map((pct, i) => {
    const m = cur * (1 + pct / 100), size = 200 + rnd(i) * 4000;
    return { id: `crowd-${i}`, token, owner: `0x${(i + 1).toString(16).padStart(40, "a")}` as Address, kind: pct < 0 ? "tramp" : "wall", mcapUsd: m,
      mcapLoUsd: m * 0.99, mcapHiUsd: m * 1.01, amount: BigInt(0), sizeUsd: size, status: "active", filledFrac: 0,
      feesEarnedUsd: 0, pointsEarned: 0, createdAt: Date.now() } as TrampWall;
  });
}

export function createMockAdapter(getCurrentMcap: () => number): TrampWallAdapter {
  const crowd = new Map<string, TrampWall[]>();
  return {
    async isGraduated() {
      const q = new URLSearchParams(window.location.search).get("graduated");
      if (q === "1") return true; if (q === "0") return false;
      return getCurrentMcap() >= 33_000; // graduation at $33K
    },
    async list(token) {
      const k = token.toLowerCase();
      if (!crowd.has(k) && getCurrentMcap() > 0) crowd.set(k, seed(token, getCurrentMcap()));
      return [...(crowd.get(k) || []), ...load().filter((t) => t.token.toLowerCase() === k && t.status !== "cancelled")];
    },
    async listMine(owner, token) {
      return load().filter((t) => t.owner === owner && (!token || t.token.toLowerCase() === token.toLowerCase()));
    },
    async preview(p, cur) { return computePreview(p, cur); },
    async place(p) {
      const pv = computePreview(p, getCurrentMcap());
      if (!pv.valid) return { ok: false, reason: pv.reason };
      const tw: TrampWall = { id: `tw-${Date.now().toString(36)}`, token: p.token, owner: MOCK_ME, kind: p.kind, mcapUsd: p.mcapUsd,
        mcapLoUsd: pv.mcapLoUsd, mcapHiUsd: pv.mcapHiUsd, amount: p.amount, sizeUsd: p.sizeUsd, status: "active", filledFrac: 0,
        feesEarnedUsd: 0, pointsEarned: 0, createdAt: Date.now() };
      save([...load(), tw]); emit({ type: "Placed", tw });
      return { ok: true, id: tw.id, txHash: "0xmock" };
    },
    async cancel(id) {
      const all = load(); const t = all.find((x) => x.id === id);
      if (!t || t.status !== "active") return { ok: false, reason: "Not active" };
      t.status = "cancelled"; save(all); emit({ type: "Cancelled", id, token: t.token });
      return { ok: true, txHash: "0xmock" };
    },
    onEvent(_token, cb) { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}

/** Mock-only: engine reports a fill (price crossed the range) → auto-pull + points. FLOW does this on-chain. */
export function mockMarkFilled(id: string) {
  const all = load(); const t = all.find((x) => x.id === id);
  if (!t || t.status !== "active") return;
  t.status = "filled"; t.filledFrac = 1; t.filledAt = Date.now(); t.pointsEarned = pointsFor(t.kind, t.sizeUsd);
  t.feesEarnedUsd = t.sizeUsd * 0.0011 * 3; save(all);
  emit({ type: "Filled", id, token: t.token, filledAt: t.filledAt, pointsEarned: t.pointsEarned });
}

export function mockFilledCounts(): { tramps: number; walls: number; bigTramps: number } {
  const f = load().filter((t) => t.status === "filled");
  return { tramps: f.filter((t) => t.kind === "tramp").length, walls: f.filter((t) => t.kind === "wall").length,
    bigTramps: f.filter((t) => t.kind === "tramp" && t.sizeUsd >= 1000).length };
}
