/** flow/gasless-withdraw Plan 1: referral attach after a gasless trade, never on the trade path. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { attachReferral, afterTrade, referralDoneKey, referrerFromRaw, REFERRAL_DONE, gaslessReferralHooks } from "../lib/server/gaslessReferral";

describe("attachReferral (attestor path, no trade delay)", () => {
  const trader = "0x00000000000000000000000000000000000000a1" as Address;
  const referrer = "0x00000000000000000000000000000000000000b2" as Address;
  const key = generatePrivateKey();

  it("is off (skipped silently) when the attestor key is unset — never falls back to a relayer key", async () => {
    const send = vi.fn();
    expect(await attachReferral({ trader, referrer, key: undefined, send })).toBe("off");
    expect(send).not.toHaveBeenCalled();
  });
  it("skips when there is no referrer, or it is already done, or it is a self-referral", async () => {
    const send = vi.fn();
    expect(await attachReferral({ trader, key, send })).toBe("skipped");
    expect(await attachReferral({ trader, referrer, alreadyDone: REFERRAL_DONE, key, send })).toBe("skipped");
    expect(await attachReferral({ trader, referrer: trader, key, send })).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
  it("fires tryAttribute once, then marks done; a second call with alreadyDone is skipped", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const markDone = vi.fn(async () => undefined);
    expect(await attachReferral({ trader, referrer, key, send, markDone })).toBe("attached");
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [string, string, string];
    expect(String(call[1]).startsWith("0x")).toBe(true);
    expect(typeof call[0]).toBe("string");
    expect(markDone).toHaveBeenCalledWith(trader);
    expect(await attachReferral({ trader, referrer, alreadyDone: REFERRAL_DONE, key, send, markDone })).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("a failed attach does not throw and does not mark done", async () => {
    const send = vi.fn(async () => ({ ok: false, message: "rpc down" }));
    const markDone = vi.fn(async () => undefined);
    expect(await attachReferral({ trader, referrer, key, send, markDone })).toBe("failed");
    expect(markDone).not.toHaveBeenCalled();
    await expect(attachReferral({ trader, referrer, key, send: async () => { throw new Error("boom"); }, markDone })).resolves.toBe("failed");
    expect(markDone).not.toHaveBeenCalled();
  });
  it("AlreadyAttributed / SelfReferral is treated as settled (mark done, no retry loop)", async () => {
    const markDone = vi.fn(async () => undefined);
    expect(await attachReferral({ trader, referrer, key, send: async () => ({ ok: false, message: "execution reverted: AlreadyAttributed()" }), markDone })).toBe("attached");
    expect(markDone).toHaveBeenCalled();
  });
  it("referrerFromRaw only accepts a real 0x address", () => {
    expect(referrerFromRaw({ referrer })).toBe(referrer);
    expect(referrerFromRaw({ referrer: "nope" })).toBeUndefined();
    expect(referrerFromRaw({ })).toBeUndefined();
  });
  it("afterTrade never awaits the task (fire-and-forget / waitUntil)", async () => {
    let done = false;
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    afterTrade(async () => { await held; done = true; });
    expect(done).toBe(false);
    release();
    await held;
    await Promise.resolve();
    expect(done).toBe(true);
  });
  it("referralDoneKey is relay:ref:{wallet}", () => {
    expect(referralDoneKey(trader)).toBe(`relay:ref:${trader}`);
  });
});
