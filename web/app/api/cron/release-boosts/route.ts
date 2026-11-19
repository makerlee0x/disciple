/**
 * GET /api/cron/release-boosts — Vercel cron (vercel.json, hourly). Hidden launches on Easy: the First BOOST is
 * locked on the creator until orbit, and AnonLauncher is the creator, so AnonLauncher holds it (heldBoost) and
 * releaseBoost(token) sends it, plus the Easy crew tips it earned, to the player's private address. Stealth owners have
 * no gas, so the relayer EOA calls it for them. releaseBoost is permissionless and only pays the recorded recipient.
 * Coin scan: BoostHeld logs from the KV cursor `boost:cur:<launcher>` (starts at the stack's fromBlock), coins kept in
 * `boost:tokens:<launcher>`, released ones in `boost:done:<launcher>`. Each release is simulated first, so a coin still before orbit costs nothing.
 * Auth: Bearer CRON_SECRET, constant-time; in production an unset CRON_SECRET ⇒ 503. Run lock `boost:lock` (55 s).
 * BOOST_RELEASE_DISABLED=1 turns it off. Skipped (no KV or RPC use) until lib/anonModes ANON_ANY_MODE_LIVE.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createPublicClient, createWalletClient, formatEther, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { ANON_ADDONS } from "@/lib/anon";
import { ANON_ANY_MODE_LIVE, anonLauncherModesAbi } from "@/lib/anonModes";
import { kv } from "@/lib/server/kv";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { KEEPER_LIMITS, gasLimitFor } from "@/lib/feeRouteKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const SCAN_CHUNK = BigInt(50_000);
const MAX_PER_RUN = 20;
const errText = (e: unknown) => String((e as { shortMessage?: string }).shortMessage || (e as Error).message || e);

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.BOOST_RELEASE_DISABLED === "1") return NextResponse.json({ ok: true, skipped: "disabled" });
  if (!ANON_ANY_MODE_LIVE) return NextResponse.json({ ok: true, skipped: "anon launches are Expert only" });
  const launcher = ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher;
  if (!launcher || launcher === ZERO) return NextResponse.json({ ok: true, skipped: "no anon launcher" });
  let key: `0x${string}`;
  try { key = relayerKey(); } catch (e) { return NextResponse.json({ error: isRelayerNotConfigured(e) ? "relayer_not_configured" : "relayer_error" }, { status: 503 }); }

  const store = kv(), a = launcher.toLowerCase();
  if (!(await store.setNX("boost:lock", "1", 55))) return NextResponse.json({ ok: true, skipped: "locked" });
  try {
    const d = deployment();
    const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
    const relayer = privateKeyToAccount(key);
    const wc = createWalletClient({ chain: ACTIVE_CHAIN, transport: http(undefined, { retryCount: 0 }), account: relayer });

    // 1) Easy hidden launches whose First BOOST was held, since the cursor
    const latest = await pc.getBlockNumber();
    const curKey = `boost:cur:${a}`, tokensKey = `boost:tokens:${a}`, doneKey = `boost:done:${a}`;
    let cur = BigInt((await store.get(curKey)) ?? (d.fromBlock - BigInt(1)).toString());
    const fresh: string[] = [];
    while (cur < latest) {
      const to = cur + SCAN_CHUNK > latest ? latest : cur + SCAN_CHUNK;
      const logs = await pc.getContractEvents({ address: launcher, abi: anonLauncherModesAbi, eventName: "BoostHeld", fromBlock: cur + BigInt(1), toBlock: to });
      for (const l of logs) { const t = (l.args as { token?: string }).token; if (t) fresh.push(t.toLowerCase()); }
      cur = to;
    }
    if (fresh.length) await store.sadd(tokensKey, ...fresh);
    await store.set(curKey, cur.toString());

    // 2) release the ones past orbit (simulation reverts NothingToClaim before orbit with no crew tips yet)
    const t0 = Date.now();
    const done = new Set(await store.smembers(doneKey));
    const tokens = (await store.smembers(tokensKey)).filter((t) => !done.has(t)).slice(0, MAX_PER_RUN);
    const results: Record<string, string> = {};
    for (const token of tokens) {
      if (Date.now() - t0 > KEEPER_LIMITS.DEADLINE_MS) { results[token] = "skipped: out of time this run"; continue; }
      try {
        const [recipient] = await pc.readContract({ address: launcher, abi: anonLauncherModesAbi, functionName: "heldBoost", args: [token as Address] });
        if (recipient === ZERO) { await store.sadd(doneKey, token); results[token] = "already released"; continue; }
        const { request } = await pc.simulateContract({ account: relayer, address: launcher, abi: anonLauncherModesAbi, functionName: "releaseBoost", args: [token as Address] });
        const est = await pc.estimateContractGas({ account: relayer, address: launcher, abi: anonLauncherModesAbi, functionName: "releaseBoost", args: [token as Address] });
        const gas = gasLimitFor(est);
        if (gas == null) { results[token] = `skipped: needs ${est} gas`; continue; }
        const hash = await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce((nonce) => wc.writeContract({ ...request, gas, nonce } as never)), 0);
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15_000 });
        if (rc.status !== "success") { results[token] = `reverted ${hash}`; continue; }
        const [left] = await pc.readContract({ address: launcher, abi: anonLauncherModesAbi, functionName: "heldBoost", args: [token as Address] });
        if (left === ZERO) await store.sadd(doneKey, token);
        results[token] = hash;
      } catch (e) {
        const m = errText(e);
        results[token] = /NothingToClaim|NothingHeld/.test(m) ? "before orbit" : `error: ${m.slice(0, 160)}`;
      }
    }
    const bal = await pc.getBalance({ address: relayer.address }).catch(() => BigInt(0));
    return NextResponse.json({ ok: true, held: tokens.length, newCoins: fresh, results, relayer: relayer.address, relayerBalanceEth: formatEther(bal) });
  } finally {
    await store.del("boost:lock").catch(() => {});
  }
}
