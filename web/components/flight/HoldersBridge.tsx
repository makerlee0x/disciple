"use client";

import { useEffect } from "react";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { anonLaunchers } from "@/lib/anon";
import { holderKinds, protocolLabels } from "@/lib/holders";
import type { Address } from "@/lib/protocol";
import { curveOf, publicClient } from "@/lib/protocol-viem";
import { tokenAbi } from "@/lib/abi";
import { onWallet } from "@/lib/wallet";
import { DEFAULT_SUPPLY } from "@/lib/pnl";
import { fetchHolders, overlayOwn, type BuildOpts, type HolderLabel, type HoldersSnapshot } from "@/lib/flight/holders";
import { OWN, ownRead } from "@/lib/flight/ownLedger";

/**
 * Live coin pages: feeds the engine REAL holders (window 'disciple:holders-real' → engine S.holders → KOTH panel + the chat
 * HOLDERS tab) from on-chain balances, replacing the session "fuelers" list. Source: SITE's /api/holders when it exists,
 * else balanceOf of the known traders (/api/trades fills + traders seen in the live feed + the user's account).
 * Protocol addresses are labelled (curve / pool / locker) and never ranked; the user's row is `mine`.
 * Refresh: every 20 s, ~2 s after any trade on this coin, and on wallet change. Never throws, renders nothing.
 */
const REFRESH_MS = 20_000;
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export default function HoldersBridge({ coin }: { coin: string }) {
  useEffect(() => {
    if (!isDeployed() || !isAddr(coin)) return;
    let alive = true, me: string | null = null, price = 0, supply = DEFAULT_SUPPLY, timer: ReturnType<typeof setTimeout> | null = null, busy = false;
    const pc = publicClient();
    const seen = new Set<string>();
    const d = deployment();
    // the shared protocol label map (lib/holders protocolLabels — same as /api/holders)
    const labels: Record<string, HolderLabel> = protocolLabels(d, { lockers: anonLaunchers(ACTIVE_CHAIN.id) });
    // post-grad fallback for rows the API didn't tag: SITE's holderKinds (#158: same book as /api/holders `kind` — routers,
    // Launchpad, Migration, LockedLP, … , 0x0 / 0x…dEaD) fills in anything protocolLabels doesn't name. No GAME address table.
    for (const [a, k] of Object.entries(holderKinds(d, { lockers: anonLaunchers(ACTIVE_CHAIN.id) }))) if (!labels[a]) labels[a] = k;
    const curveP = curveOf(pc, coin as Address).then((c) => { Object.assign(labels, protocolLabels({}, { curve: c })); }).catch(() => undefined);
    const opts = (): BuildOpts => ({ me, labels, totalSupplyRaw: BigInt(Math.round(supply)) * BigInt(10) ** BigInt(18), priceUsd: price, limit: 50 });
    let last: { raw: HoldersSnapshot; o: BuildOpts } | null = null;
    // our own fill landed (TradeBridge applied the receipt logs to the ledger): redraw our row NOW from the ledger, no RPC
    const onOwn = (e: Event) => { const t = (e as CustomEvent<{ tokens?: string[] }>).detail?.tokens || [];
      if (!alive || !last || !me || !t.some((x) => x.toLowerCase() === coin.toLowerCase())) return;
      const v = OWN.get(coin, me); if (v === undefined) return;
      dispatchEvent(new CustomEvent("disciple:holders-real", { detail: overlayOwn(last.raw, { ...last.o, me, priceUsd: price || last.o.priceUsd }, v) })); };
    const run = async () => {
      if (!alive || busy) return; busy = true;
      try {
        await curveP;
        const o = opts();
        const raw = await fetchHolders(coin, o, {
          fetchJson: async (url) => { const r = await fetch(url, { cache: "no-store" }); return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null }; },
          balancesOf: (addrs) => Promise.all(addrs.map((a) => pc.readContract({ address: coin as Address, abi: tokenAbi, functionName: "balanceOf", args: [a as Address] }).catch(() => BigInt(0)) as Promise<bigint>)),
          extra: () => [...seen],
        });
        // own row: the receipt ledger (fill pending ⇒ ledger value, reconcile pinned at a block ≥ the fill's; never older)
        const mine = me && raw && OWN.entry(coin, me) ? await ownRead(OWN, pc as unknown as Parameters<typeof ownRead>[1], coin as `0x${string}`, me as `0x${string}`,
          () => pc.readContract({ address: coin as Address, abi: tokenAbi, functionName: "balanceOf", args: [me as Address] }) as Promise<bigint>).catch(() => OWN.get(coin, me!)) : undefined;
        const snap = raw ? overlayOwn(raw, o, mine) : raw;
        if (snap) last = { raw: raw!, o };
        if (alive && snap) dispatchEvent(new CustomEvent("disciple:holders-real", { detail: snap }));
      } catch { /* keep the last list */ } finally { busy = false; }
    };
    const soon = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void run(); }, ms); };
    const onEvent = (e: Event) => { const x = (e as CustomEvent<{ type?: string; token?: string; trader?: string }>).detail;
      if (x?.type !== "Trade" || (x.token && x.token.toLowerCase() !== coin.toLowerCase())) return;
      if (x.trader && isAddr(x.trader)) seen.add(x.trader.toLowerCase());
      soon(2000); };
    const onMark = (e: Event) => { const m = (e as CustomEvent<{ mcap: number; supply?: number }>).detail; if (m?.mcap > 0) { supply = m.supply || supply; price = m.mcap / supply; } };
    const onTrade = () => soon(2500);
    addEventListener("disciple:event", onEvent); addEventListener("disciple:mark", onMark); addEventListener("disciple:livetrade", onTrade); addEventListener("disciple:ownbalance", onOwn);
    const pushMe = () => dispatchEvent(new CustomEvent("disciple:wallet", { detail: { address: me } }));
    const off = onWallet((a) => { me = a ? a.toLowerCase() : null; pushMe(); soon(300); });
    let boots = 0; const onBoot = () => { if (boots++ < 3) pushMe(); };   // engine (maybe in its worker) boots after mount
    addEventListener("disciple:ammo", onBoot);
    const iv = setInterval(() => { if (!document.hidden) void run(); }, REFRESH_MS);
    soon(800);
    return () => { alive = false; clearInterval(iv); if (timer) clearTimeout(timer); off?.();
      removeEventListener("disciple:event", onEvent); removeEventListener("disciple:mark", onMark); removeEventListener("disciple:livetrade", onTrade); removeEventListener("disciple:ownbalance", onOwn); removeEventListener("disciple:ammo", onBoot); };
  }, [coin]);
  return null;
}
