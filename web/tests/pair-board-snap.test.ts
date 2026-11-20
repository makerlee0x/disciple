import { describe, expect, it, vi } from "vitest";

// the slow build (home build, burn index, prices) is what the snapshot keeps off the request path
const build = vi.fn(async () => ({ launches: [], fills: [] }));
vi.mock("@/lib/server/home", () => ({ getPairInputs: build }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn(); } }));

const { kv } = await import("@/lib/server/kv");
const { pairRows } = await import("@/lib/server/pairBoard");
const { seasonAt } = await import("@/lib/duel/season");

describe("pair board snapshot", () => {
  it("answers from the KV snapshot when this instance has nothing, and refreshes it after", async () => {
    const season = seasonAt(Date.now()).id;
    const rows = [{ symbol: "A", address: "0xa", volumeUsd: 5, rockets: 1 }];
    await kv().set("pairs:board:snap:v1", JSON.stringify({ at: Date.now() - 10 * 60_000, rows, season }));
    const snap = await pairRows();
    expect(snap.rows).toEqual(rows);   // the stale snapshot, at once
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));   // and one background build
  });
  it("a fresh copy in this instance needs no read and no build", async () => {
    build.mockClear();
    const a = await pairRows();
    const b = await pairRows();
    expect(b).toBe(a);
    expect(build).not.toHaveBeenCalled();
  });
});
