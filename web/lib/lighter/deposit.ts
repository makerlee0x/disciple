/**
 * Add cash into Lighter, browser side. Cash (USDG on Robinhood Chain) goes to the player's Lighter deposit address with
 * the usual gasless cash-out (no gas, no new signature prompt), Lighter's bridge credits it as USDC (the first deposit
 * creates the Lighter account), then the rest of Lighter set-up runs on its own (silent signatures).
 * Lighter on Robinhood Chain: an intent address on our own chain (1 USDG min). Lighter main: a Relay deposit address
 * that swaps it to USDC on Arbitrum and delivers it to the wallet's Lighter intent address ($6 min). The server picks
 * (lib/server/lighter/bridge.ts).
 */
import { formatUnits, parseUnits, type Address } from "viem";
import { publicClient } from "@/lib/protocol-viem";
import { gaslessSigner } from "@/lib/wallet";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { lighterSetUp, lighterStatus, type LighterStep } from "./client";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type AddCashStep = "address" | "sending" | "arriving" | "setup" | "done";
/** "arriving": when it should land (ms epoch), for the countdown on the button (maker 2026-11-20: "so they know it's working"). */
/** "setup": creditedUsd = what Lighter actually credited (its collateral went up by that), for the done line. */
export type AddCashInfo = { landsAt?: number; creditedUsd?: number };
/** Seconds Lighter takes to credit a deposit once it reaches its intent address (on top of Relay's own estimate). */
export const LIGHTER_CREDIT_SEC = 60;
/** Est. when Relay gives no time: the swap + bridge usually take well under a minute. */
export const RELAY_DEFAULT_SEC = 45;
/** When a deposit sent at `sentAt` should land. Pure, tested. */
export function landsAt(sentAt: number, relayEtaSec?: number | null, viaRelay = true): number {
  const relay = viaRelay ? (relayEtaSec && relayEtaSec > 0 ? relayEtaSec : RELAY_DEFAULT_SEC) : 0;
  return sentAt + (relay + LIGHTER_CREDIT_SEC) * 1000;
}

async function post<T>(f: Fetcher, op: string, extra: Record<string, unknown> = {}): Promise<T> {
  const r = await f("/api/lighter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...extra }) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string } & T;
  if (!r.ok || !j.ok) throw new Error(j.reason || "Lighter didn't answer.");
  return j;
}

/** Moves `usd` of cash into Lighter and finishes set-up. `onStep` reports progress; resolves with the Lighter step. */
export async function lighterAddCash(f: Fetcher, usd: number, signMessage: (msg: string) => Promise<string>, onStep: (s: AddCashStep, info?: AddCashInfo) => void = () => {}): Promise<LighterStep> {
  const owner = gaslessSigner();
  if (!owner) throw new Error("Sign in first.");
  onStep("address");
  const [{ address, minNew, min, chainId, etaSec, outUsd }, before] = await Promise.all([
    post<{ address: Address; minNew: number; min: number; chainId?: number | null; etaSec?: number; outUsd?: number }>(f, "deposit-address", { usd }),
    lighterStatus(f) as Promise<{ step: LighterStep; collateral?: string }>,
  ]);
  // 2026-11-18: a testnet build sent test USDG to a real Lighter main deposit address. Never send across chains.
  if (!chainId || chainId !== ACTIVE_CHAIN.id) throw new Error(`Turbo cash can't be added from this build (${ACTIVE_CHAIN.name}).`);
  const floor = before.step === "deposit" ? minNew : min;
  if (!(usd >= floor)) throw new Error(`Add at least $${floor}.`);

  onStep("sending");
  const { quoteGaslessWithdraw, signGaslessWithdraw, submitGaslessWithdraw } = await import("@/lib/trade/gaslessWithdrawClient");
  const { privyIdentityToken } = await import("@/lib/aa/session");
  const q0 = await quoteGaslessWithdraw({ signer: owner.address });
  const amount = parseUnits(usd.toFixed(2), q0.usdgDecimals);
  const q = await quoteGaslessWithdraw({ amount, signer: owner.address });
  if (amount < q.minAmount) throw new Error(`Add at least $${Number(formatUnits(q.minAmount, q.usdgDecimals)).toFixed(2)}.`);
  const tokenP = privyIdentityToken().catch(() => null);
  const req = await signGaslessWithdraw(publicClient() as never, owner, { amount, destination: address, quote: q });
  await submitGaslessWithdraw(req, "/api/gasless", fetch, await tokenP);

  // Lighter credits it within a few minutes; the account (or its cash) showing up is the signal
  // outUsd is only set on the Relay route (Lighter main); Lighter on our own chain has no swap leg
  onStep("arriving", { landsAt: landsAt(Date.now(), etaSec, outUsd != null) });
  const was = Number(before.collateral ?? 0);
  const t0 = Date.now();
  let credited = 0;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 5_000));
    const st = (await lighterStatus(f).catch(() => null)) as { step: LighterStep; collateral?: string } | null;
    if (st && st.step !== "deposit" && Number(st.collateral ?? 0) > was) { credited = Math.round((Number(st.collateral) - was) * 100) / 100; break; }
    if (Date.now() - t0 > 20 * 60_000) throw new Error("Lighter hasn't credited it yet. It can take a while; check back soon.");
  }
  onStep("setup", { creditedUsd: credited });
  const step = await lighterSetUp(f, signMessage);
  onStep("done");
  return step;
}
