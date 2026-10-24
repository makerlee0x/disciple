"use client";

import { TRADE_PENDING_EVENT } from "@/lib/game/exitGuard";
import { useEffect, useRef, useState } from "react";
import { deployment, isDeployed } from "@/lib/chains";
import { MODES } from "@/lib/config";
import type { Address } from "@/lib/protocol";
import { balanceHint, createViemProtocol, decimalsOf, publicClient, readQuote, tokenBalance, usdToAmountIn, warmRoute, shotAmountIn, bumpBalance } from "@/lib/protocol-viem";
import { decodeTradeFill, units, type LogLike } from "@/lib/flight/fills";
import { OpMarks, blockOfLogs, boostHoverMs, doneLine, ownReceipt, takeReceipt, tradeClick, tradeMs, tradeStart, type TradeMs } from "@/lib/flight/tradeSpeed";
// TODO(#140): once SITE #140 (lib/trade/timing.ts) is on the base, add:
//   import { markTradeClick } from "@/lib/trade/timing";  setTradeClickMark(markTradeClick);   (setTradeClickMark from tradeSpeed)
import { freshSellBalance, sellAmount, sellAmountFor } from "@/lib/flight/liveSell";
import { OWN, RECONCILE_MIN_MS, ownRead } from "@/lib/flight/ownLedger";
import { DEFAULT_SUPPLY } from "@/lib/pnl";
import { activeAddress, isSmartMode, onWallet } from "@/lib/wallet";
import { aaWarm, sessionMaxSlippageBps } from "@/lib/aa/session";
import { clampSlippage, suggestedSessionMax } from "@/lib/aa/slippage";
import AmmoTierNotice from "./AmmoTierNotice";
import { fmtMoney } from "@/lib/pnl";
import SwapSettingsModal from "./trade/SwapSettingsModal";
import { DEFAULT_BUY, SELL_KEYS, SWAP_PREFIX, loadSettings, sanitize, saveSettings, sellLabel, slippageBps, type SellSlot, type SwapSettings } from "@/lib/trade/swapSettings";
import { keyLabel, useGameSettings } from "@/lib/game/settings";
import { useT } from "@/lib/game/i18n";
import { readCoinRules } from "@/lib/flight/coinRules";
import { COPY, REJECTED, awaitResolution, gasKindFor, isPendingUnknown, nextPressId, type GradHint, releasePress, reservePress, reservePressTokens, canSpend, rawToUsd, spendableRaw, tradeErrorCopy, unreservedTokens } from "@/lib/flight/rapidTap";
import { reservedTokens, subscribe as onReservations } from "@/lib/flight/reservationsShim";
import { gasReservePerOp, warmGasPrice } from "@/lib/flight/gasReserve";
/** per-op gas reserve in $ (FLOW's accessor, adapted) — pushed to the engine with disciple:cash for its reservation check */
const gasUsd = () => { try { return rawToUsd(gasReservePerOp()); } catch { return 0; } };   // display / engine pre-check only
/** the last real USDG balance, RAW (reservation math stays bigint; decimals from config) */
const CASH_RAW: { v: bigint | null } = { v: null };

type Ammo = { tier: number | null; rocketTier?: number | null; name: string | null; usd: number[]; names: string[]; mode: number };

type BridgeResult = { ok: boolean; reason?: string; txHash?: string; fillUsd?: number; fillTokens?: number; ms?: TradeMs; lateFill?: true; unknown?: true };
/** pending: the send timed out — outcome UNKNOWN (may still land); `late` resolves to the real outcome (engine keeps hovering). */
type Bridge = (side: "buy" | "sell", usd: number, o?: { frac?: number; all?: boolean }) => Promise<BridgeResult & { pending?: true; late?: Promise<BridgeResult> }>;
declare global {
  interface Window {
    __discipleTrade?: Bridge;
    /** Connected trading account, lowercase (the smart account credited as `trader` in Trade events = the trades:w:* key);
     *  read by the flight minimap (public/flight/engine.js) to mark the user's own fills. Unset when disconnected. */
    __flightWallet?: string;
  }
}

/**
 * Ammo bar + bridge: the flight engine's shots (keys / these buttons) become real trades once a wallet is
 * connected — buy/sell(…, recipient) on the curve, DiscipleRouter after graduation; approve once per spender.
 * No chain or no wallet ⇒ no bridge ⇒ engine keeps paper fills (mock/replay unchanged).
 */
type Pos = { size: number; valueUsd: number; costBasis: number };
/** % sells, FIXED at 10/25/50/100% of the bag (plus the one custom sell field). Keys Z/X/C/V.
 * The SELL row itself is drawn in the engine's AMMO panel. Clicking a preset only SELECTS it (disciple:sellselect);
 * DUMP / Shift (disciple:dump) sells the selected % (or the custom sell field); Z/X/C/V only SELECT (never trade).
 * Sell-size keys are read by the engine (bindings from the ESC settings menu) and arrive here as disciple:sellselect. */
type Sell = { id: string; label: string; frac: number; key: string };
const toSells = (sl: SellSlot[]): Sell[] => sl.map((v, i) => ({ id: String(v), label: sellLabel(v), frac: v / 100, key: SELL_KEYS[i] }));
const DEFAULT_SELL_SEL = 1;   // 25%

/** Bottom bar = custom $ + BOOST (buy) / DUMP (sell) + position/paper badge. storagePrefix scopes Swap settings (sim has its own). */
/* own balances from the sync receipt (lib/flight/ownLedger): the public RPC lags the sequencer ~0.7 s, so the HUD / cash /
   sell sizing read through the ledger; protocol-viem's balance cache is kept in step (its hint is what trades check). */
type PcLike = ReturnType<typeof publicClient>;
async function syncCache(pc: PcLike, erc20: Address, me: Address, v: bigint) {
  try { const cur = await balanceHint(pc, erc20, me, 60_000); if (cur !== v) bumpBalance(erc20, me, v - cur); } catch { /* next poll */ }
}
async function ownBalance(pc: PcLike, erc20: Address, me: Address, plain: () => Promise<bigint>) {
  const wasPending = OWN.pending(erc20, me);
  const v = await ownRead(OWN, pc as unknown as Parameters<typeof ownRead>[1], erc20 as `0x${string}`, me as `0x${string}`, plain);
  if (wasPending || OWN.pending(erc20, me)) await syncCache(pc, erc20, me, v);   // pinned / rejected read: keep protocol-viem's cache on the ledger value
  return v;
}
const ownHint = async (pc: PcLike, erc20: Address, me: Address, maxAge: number) => OWN.get(erc20, me) ?? balanceHint(pc, erc20, me, maxAge);

export default function TradeBridge({ token, storagePrefix = SWAP_PREFIX }: { token: string; storagePrefix?: string }) {
  const [mode, setMode] = useState(0);
  const [custom, setCustom] = useState("");
  const gs = useGameSettings();
  const t = useT();
  const [pos, setPos] = useState<Pos>({ size: 0, valueUsd: 0, costBasis: 0 });
  useEffect(() => {
    const h = (e: Event) => setPos((e as CustomEvent<Pos>).detail);
    addEventListener("disciple:position", h);
    return () => removeEventListener("disciple:position", h);
  }, []);
  // Buy preset $ sizes come from the engine: the player's own 4 (Swap settings / ESC menu) else $10/$25/$50/$100 (no mcap tier scaling).
  const [ammo, setAmmo] = useState<Ammo>({ tier: null, name: null, usd: MODES.map((m) => m.usd), names: MODES.map((m) => m.name), mode: 0 });
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<Ammo>).detail; setAmmo(d); if (typeof d.mode === "number") setMode(d.mode); };
    addEventListener("disciple:ammo", h);
    dispatchEvent(new Event("disciple:ammo-query"));
    return () => removeEventListener("disciple:ammo", h);
  }, []);
  const [addr, setAddr] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [last, setLast] = useState("");
  const valid = isDeployed() && /^0x[0-9a-fA-F]{40}$/.test(token);
  useEffect(() => onWallet(setAddr), []);
  // Minimap own-fill markers: expose the trading account (onWallet emits the smart account in smart mode, the EOA on the
  // legacy path; either way the address Trade events credit as trader). Follows account changes; cleared on disconnect/unmount.
  useEffect(() => {
    if (addr) window.__flightWallet = addr.toLowerCase();
    else delete window.__flightWallet;
    return () => { delete window.__flightWallet; };
  }, [addr]);
  const live = valid && !!addr;
  // last real mark (engine 'disciple:mark', ≤10/s) — live sell $ sizing and receipt decoding of hook-only fills
  const markRef = useRef({ mcap: 0, supply: DEFAULT_SUPPLY });
  useEffect(() => { const h = (e: Event) => { const d = (e as CustomEvent<{ mcap: number; supply?: number }>).detail; if (d?.mcap > 0) markRef.current = { mcap: d.mcap, supply: d.supply || DEFAULT_SUPPLY }; };
    addEventListener("disciple:mark", h); return () => removeEventListener("disciple:mark", h); }, []);
  const lastOwnTradeAt = useRef(0);
  // gas kind (FLOW GasOpKind): the warm buy preview for the selected amount (graduates / mcapAfter / venue) → gasKindFor
  const gradRef = useRef<GradHint | null>(null);
  // the press whose "· sending…" line is showing: disciple:op events update it only when their pressId matches (no heuristic)
  const linePress = useRef<string | null>(null);
  const warmRef = useRef<() => Promise<void>>(async () => {});   // HOT PATH warm tick (below); re-run right after our own trade
  const liveTokens = useRef(0);   // last real balanceOf (whole tokens) of the trading account
  // Swap settings, per scope (sim / paper / live)
  const scope = storagePrefix + (live ? "live" : "paper");
  const [cfg, setCfg] = useState<SwapSettings>(() => loadSettings(scope));
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const sellSelRef = useRef(DEFAULT_SELL_SEL);
  const [showCfg, setShowCfg] = useState(false);
  useEffect(() => { setCfg(loadSettings(scope)); }, [scope]);
  const SELLS = toSells(cfg.sells);
  // push overrides + tag state to the engine (again whenever it (re)announces ammo, i.e. after boot)
  const pushCfg = useRef(() => {});
  pushCfg.current = () => { dispatchEvent(new CustomEvent("disciple:ammo-override", { detail: { usd: cfgRef.current.buy } })); dispatchEvent(new CustomEvent("disciple:pnltag", { detail: { on: cfgRef.current.tag } }));
    dispatchEvent(new CustomEvent("disciple:custombuy", { detail: { usd: customRef.current } })); pushPresets(); };
  // ESC settings menu (components/flight/SettingsMenu.tsx) edits the same Swap-settings amounts: it reads them via
  // disciple:presets and writes them back with disciple:presets-set (one book for the trade bar, ammo panel and menu).
  const pushPresets = () => dispatchEvent(new CustomEvent("disciple:presets", { detail: { buy: cfgRef.current.buy, sells: cfgRef.current.sells } }));
  const booted = useRef(false);
  useEffect(() => { pushCfg.current(); }, [cfg]);
  useEffect(() => {
    const q = () => pushPresets();
    const set = (e: Event) => { const d = (e as CustomEvent<{ buy?: number[] | null; sells?: SellSlot[] }>).detail; if (!d) return;
      // only the buy amounts are customisable; sell sizes are fixed (sanitize pins them), so a `sells` field is ignored
      const n = sanitize({ ...cfgRef.current, ...(d.buy !== undefined ? { buy: d.buy } : {}) });
      setCfg(n); saveSettings(scope, n); };
    addEventListener("disciple:presets-query", q); addEventListener("disciple:presets-set", set);
    return () => { removeEventListener("disciple:presets-query", q); removeEventListener("disciple:presets-set", set); };
  }, [scope]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = () => { if (!booted.current) { booted.current = true; pushCfg.current(); } }; addEventListener("disciple:ammo", h); return () => removeEventListener("disciple:ammo", h); }, []);
  useEffect(() => { const o = () => setShowCfg(true); const t = (e: Event) => { const on = !!(e as CustomEvent<{ on: boolean }>).detail?.on; if (on !== cfgRef.current.tag) { const n = { ...cfgRef.current, tag: on }; setCfg(n); saveSettings(scope, n); } };
    addEventListener("disciple:swapsettings", o); addEventListener("disciple:pnltag-state", t); return () => { removeEventListener("disciple:swapsettings", o); removeEventListener("disciple:pnltag-state", t); }; }, [scope]);

  useEffect(() => {
    if (!live) return;
    const client = createViemProtocol();
    const pc = publicClient();
    // click → confirm → fill timing: the AA layer's disciple:op submitted/confirmed marks, by op (lib/flight/tradeSpeed)
    const marks = new OpMarks();
    const onOp = (e: Event) => marks.note((e as CustomEvent).detail);
    addEventListener("disciple:op", onOp);
    /** Fix 3: receipt logs → exact USDG / token amounts (UsdgTrade, else the venue Trade event) → 'disciple:fillreceipt' {txHash,
     *  side, usd, tokens, feeUsd}; components/PnlHud swaps its estimate for it (lib/pnl reconcileFill), the engine draws the
     *  own sell (@sellfill). Trade speed: the logs come back WITH the send (sync relay / userOp receipt, lib/wallet.execCalls →
     *  takeReceipt) ⇒ decoded at "✓ done", no 2nd receipt poll. Only when none came back (slow path) poll for the receipt. */
    /** At confirm: the fill's token + USDG Transfer deltas → the own-balance ledger (no balanceOf: the public RPC is ~0.7 s
     *  behind and would show the pre-trade balance), protocol-viem's cache kept in step, then 'disciple:ownbalance' → the HUD
     *  position / uPnL and cash update NOW. The public RPC only reconciles ≥ 1 s later, pinned at a block ≥ the fill's. */
    const applyOwn = async (hash: string, logs: LogLike[], block?: bigint) => {
      try {
        const me = await activeAddress(), usdg = deployment().usdg, t = token as Address;
        if (block !== undefined) OWN.noteTxBlock(hash, block);
        const [bt, bu] = await Promise.all([ownHint(pc, t, me, 60_000).catch(() => undefined), ownHint(pc, usdg, me, 60_000).catch(() => undefined)]);
        const ch = OWN.applyFill(me, [t, usdg], logs, hash, (x) => (x.toLowerCase() === t.toLowerCase() ? bt : x.toLowerCase() === usdg.toLowerCase() ? bu : undefined), Date.now());
        await Promise.all(ch.map((c) => syncCache(pc, c.token as Address, me, c.value)));
        if (ch.length) dispatchEvent(new CustomEvent("disciple:ownbalance", { detail: { txHash: hash, tokens: ch.map((c) => c.token) } }));
      } catch { /* the reconcile poll catches up */ }
    };
    const bookReceipt = async (hash: string, side: "buy" | "sell", pressId?: string, bag?: number, logs?: LogLike[]) => {
      try {
        const me = await activeAddress();
        let rl = logs;
        const usdgDecP = decimalsOf(pc, deployment().usdg).catch(() => 18);   // config-known USDG ⇒ no RPC
        let block: bigint | number | undefined = blockOfLogs(logs) ?? OWN.txBlockOf(hash);
        if (!rl) {   // FALLBACK ONLY (the send returned no logs): poll the receipt. Never on the normal path (logs come with the send).
          const rc = await pc.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 60_000, pollingInterval: 250 });
          if (rc.status !== "success") return null;
          rl = rc.logs as unknown as LogLike[]; block = rc.blockNumber;
          await applyOwn(hash, rl, rc.blockNumber);   // slow path: balances from the polled receipt (block known)
        }
        // SITE (#137): raw own receipt, non-consuming — WalletButton / profile holdings book from it (no balanceOf at latest)
        const rcpt = ownReceipt(hash, rl, me, token, block);
        dispatchEvent(new CustomEvent("disciple:receipt", { detail: rcpt }));
        if (rcpt.blockNumber === null) setTimeout(() => void pc.getTransactionReceipt({ hash: hash as `0x${string}` }).then((x) => {
          if (typeof x?.blockNumber !== "bigint") return;
          OWN.noteTxBlock(hash, x.blockNumber);   // the reconcile then skips its own lookup
          dispatchEvent(new CustomEvent("disciple:receipt", { detail: { ...ownReceipt(hash, rl!, me, token, x.blockNumber), update: true } }));
        }).catch(() => undefined), RECONCILE_MIN_MS);   // off the critical path, ≥ 1 s (the public RPC lags ~0.7 s)
        const usdgDec = await usdgDecP;
        const m = markRef.current;
        const x = decodeTradeFill(rl as unknown as { address: string; topics: string[]; data: string }[],
          { token, trader: me, router: deployment().router, usdgDecimals: usdgDec, markPriceUsd: m.mcap > 0 ? m.mcap / m.supply : undefined, supply: m.supply });
        if (x && x.side === side) { dispatchEvent(new CustomEvent("disciple:fillreceipt", { detail: { txHash: hash, side, ...(pressId ? { pressId } : {}), usd: x.usd, tokens: x.tokens, feeUsd: x.feeUsd, source: x.source, ...(bag !== undefined ? { bag } : {}), blockNumber: rcpt.blockNumber, trader: me, token, logs: rl } })); return x; }
        return null;
      } catch { return null; /* the estimate stays booked */ }
    };
    window.__discipleTrade = async (side, usd, o) => {
      const t0 = performance.now(); let quoteAt: number | undefined;
      tradeStart();   // click mark hook (#140): engine hotkeys reach here without a trade-bar click; no-throw
      // RAPID TAP cash check, raw bigint (sync): this BOOST on top of every pending press' spend + gas reserves
      // gas kind: "gradBuy" (6M-gas reserve) when this BOOST could graduate the curve, else "trade" (sync, from the preview)
      const kind = gasKindFor(side, usd, gradRef.current, markRef.current.mcap);
      if (side === "buy" && CASH_RAW.v !== null && !canSpend(CASH_RAW.v, usd, kind)) {
        const avail = rawToUsd(spendableRaw(CASH_RAW.v, true, kind));
        const m = `Not enough cash: ${fmtMoney(usd)} BOOST, you have ${fmtMoney(Math.max(0, avail))}`; setLast(`✕ ${m}`); return { ok: false, reason: m };
      }
      // RAPID TAP: this press's reservation, SYNC at entry (no await): buy $ + one op's gas now; a sell's tokens once sized.
      // Released on the result (slow path: once its receipt is booked) ⇒ the next press sizes from what is really left.
      const pressId = nextPressId(); reservePress(pressId, side, token, side === "buy" ? usd : undefined, kind);
      let releaseAfter: Promise<unknown> | undefined, keep = false, bag: number | undefined, rel: "filled" | "error" | "cancel" = "error";
      // AUDIT: SITE 'pending_unknown' (receipt / relay timeout) = sent, still confirming — NOT failed. SITE keeps the hold
      // (release() refuses it) and its watcher (≤ 2 min, never resends) ends it: "resolved" (filled | error) then "release".
      // GAME keeps the exit-confirm count + tells the engine to keep hovering, and resolves on SITE's events only.
      const pendingUnknown = () => {
        keep = true;
        setLast(`${side === "buy" ? "▲" : "▼"} ${fmtMoney(usd)} · ${COPY.confirming}`);
        const late: Promise<BridgeResult> = awaitResolution(pressId).then(async (out): Promise<BridgeResult> => {
          if (out.outcome === "filled") {   // a late landing = a normal fill
            lastOwnTradeAt.current = Date.now();
            // txHash ⇒ booked from its receipt (balances pinned at the receipt block); no amountOut / no txHash (the watcher
            // saw the nonce move but not the log) ⇒ the balances are re-read (below) and the done line uses the press $.
            const fill = out.txHash ? await bookReceipt(out.txHash, side, pressId, bag) : null;
            setLast(doneLine(side, usd, { ok: true }, fill, fmtMoney));
            dispatchEvent(new Event("disciple:livetrade"));   // re-read cash / bag (pinned where the receipt block is known)
            dispatchEvent(new CustomEvent("disciple:op", { detail: { phase: "filled", side, pressId, txHash: out.txHash, ok: true, late: true, usd: fill ? fill.usd : usd, at: performance.now() } }));
            return { ok: true, txHash: out.txHash, lateFill: true, ...(fill ? { fillUsd: fill.usd, fillTokens: fill.tokens } : {}) };
          }
          if (out.outcome === "error") { setLast(`✕ ${REJECTED}`); return { ok: false, reason: REJECTED }; }   // dropped / reverted: definite
          setLast(""); dispatchEvent(new Event("disciple:livetrade"));   // hold ended otherwise (logout): calm, balances re-read
          return { ok: false, unknown: true };
        }).finally(() => bump(-1));
        return { ok: false, pending: true as const, reason: COPY.confirming, late };
      };
      // pending-trade state for the exit confirm ("Your BOOST / DUMP still lands on-chain."): in-flight count per side
      const pt = (window.__disciplePendingTrades ||= { buy: 0, sell: 0 });
      const bump = (d: number) => { pt[side] = Math.max(0, pt[side] + d); dispatchEvent(new CustomEvent(TRADE_PENDING_EVENT, { detail: { ...pt } })); };
      bump(1);
      try {
        linePress.current = pressId;
        setLast(`${side === "buy" ? "▲" : "▼"} ${fmtMoney(usd)} ${isSmartMode() ? "· sending…" : "· confirm in wallet…"}`);
        // % sells size from the (polled, ≤5 s) balance hint; $ shots from the cached launch quote price ⇒ no reads when warm
        let amountIn = side === "sell" && o?.frac && o.frac > 0 ? BigInt(0) : await shotAmountIn(pc, token as Address, side, usd);
        // bag (hoisted): sells: the wallet balance this sell was sized from → PnL HUD splits tracked / untracked pro-rata
        if (side === "sell") {
          const me = await activeAddress();
          const bal = await freshSellBalance(() => ownBalance(pc, token as Address, me, () => tokenBalance(pc, token as Address, me)), () => ownHint(pc, token as Address, me, 60_000), lastOwnTradeAt.current);
          if (bal === BigInt(0)) { setLast("NO TOKENS IN WALLET"); return { ok: false, reason: "NO TOKENS IN WALLET" }; }
          bag = units(bal);
          // % of the UNRESERVED balance (wallet − tokens pending DUMPs are already selling): 50 % then 50 % = 75 % total, always.
          // Sized + reserved in ONE sync step after the read, so a concurrent press resuming next sees this reservation.
          const free = unreservedTokens(bal, token);
          if (o?.all || (o?.frac && o.frac > 0)) amountIn = sellAmountFor(free, o);   // DUMP ALL = all that isn't already being sold
          if (amountIn > free) amountIn = free;
          if (amountIn <= BigInt(0)) { rel = "cancel"; setLast(`▼ ${COPY.allSelling}`); return { ok: false, reason: COPY.allSelling }; }   // finally: released "cancel"   // all of it is already being sold
          reservePressTokens(pressId, token, amountIn);
        }
        quoteAt = performance.now();
        // minAmountOut 0 ⇒ protocol-viem derives it from an on-chain quote − slippage (Swap settings: Auto = 1% default, or Custom)
        // One-tap session active ⇒ never exceed its on-chain max slippage (the policy would revert the trade).
        const slip = clampSlippage(slippageBps(cfgRef.current), sessionMaxSlippageBps());
        if (slip.capped) dispatchEvent(new CustomEvent("disciple:slippagecap", { detail: { maxBps: slip.sessionMaxBps, requestedBps: slip.requestedBps, suggestBps: suggestedSessionMax(slip) } }));
        // reservationId = this press id (SITE #144 TradeParams.reservationId): the trade layer merges into OUR reservation
        // instead of adding its own (else the press is counted twice). pressId = the same id (FLOW #145 TradeParams.pressId):
        // the AA layer tags its disciple:op events / errors / result with it. Both optional + ignored by a stack without them.
        // TODO(#144/#145): plain fields once TradeParams has them.
        const params = { token: token as Address, side, amountIn, minAmountOut: BigInt(0), deadline: 0, slippageBps: slip.bps, reservationId: pressId, pressId };
        const r: Awaited<ReturnType<typeof client.buy>> & { pressId?: string } = await (side === "buy" ? client.buy : client.sell)(params);
        const rp = r.pressId ?? pressId;
        const resultAt = performance.now(); if (r.ok) rel = "filled";
        if (!r.ok && isPendingUnknown(r)) return pendingUnknown();   // TradeResult.errorCode "pending_unknown": still confirming, not failed
        if (!r.ok) r.reason = tradeErrorCopy(r as typeof r & { code?: string; errorCode?: string; retryAfterMs?: number });   // rate_limited → "Slow down", spend_limit → "Spend limit reached"
        lastOwnTradeAt.current = Date.now();
        // Fill from the logs the send returned, right now (no 2nd waitForTransactionReceipt); slow path without logs: polled below
        const logs = r.ok ? takeReceipt(r.txHash) : undefined;
        if (r.ok && r.txHash && logs) await applyOwn(r.txHash, logs);   // position / cash from the receipt, before fillreceipt
        const fill = r.ok && r.txHash && logs ? await bookReceipt(r.txHash, side, rp, bag, logs) : null;
        const fillAt = fill ? performance.now() : undefined;
        // "✓ done" shows the FILLED $ from the decoded logs (was: the pre-trade estimate, e.g. $208.25 vs a $245 fill)
        setLast(doneLine(side, usd, r, fill, fmtMoney));
        if (r.ok && r.txHash && !logs) releaseAfter = bookReceipt(r.txHash, side, rp, bag).then((x) => { if (x) setLast(doneLine(side, usd, r, x, fmtMoney)); });
        // balances: applied from the receipt logs above (applyOwn; slow path: from the polled receipt). No post-trade balanceOf
        // here (was: buy bumpBalance(amountOut) / sell tokenBalance after 1.2 s, which a lagging RPC could roll back).
        setTimeout(() => dispatchEvent(new Event("disciple:livetrade")), 1500);   // refresh the real balance
        // our own trade moved the price: re-warm the active amount's quote now (protocol-viem dropped the route quotes)
        // TODO(#140): REMOVE this immediate post-trade re-warm once SITE #140 lands: protocol-viem then re-reads the quotes
        // itself after our own trade. KEEP the 150 ms custom-$ debounce re-warm below (useEffect on customUsd).
        setTimeout(() => void warmRef.current(), 0);
        const ms = tradeMs(t0, { quoteAt, op: (marks.byPress(rp) ?? marks.byTx(r.txHash)), resultAt, fillAt });
        // timing instrumentation (no UI): addEventListener('disciple:op', e => e.detail.phase === 'filled' && console.log(e.detail))
        dispatchEvent(new CustomEvent("disciple:op", { detail: { phase: "filled", side, pressId: rp, txHash: r.txHash, ok: r.ok, usd: fill ? fill.usd : usd, logs: logs ? "returned" : "polled", ms, clickToConfirmMs: ms.confirm, hoverMs: boostHoverMs(performance.now() - t0),   /* rocket waited at the 70 % cap (engine @boostanim) */ op: (marks.byPress(rp) ?? marks.byTx(r.txHash))?.timings, at: performance.now() } }));
        return { ok: r.ok, txHash: r.txHash, reason: r.reason, ...(fill ? { fillUsd: fill.usd, fillTokens: fill.tokens } : {}), ms };
      } catch (e) {
        if (isPendingUnknown(e)) return pendingUnknown();   // ProtocolError("pending_unknown"): SITE holds + watches it
        const m = tradeErrorCopy({ ok: false, code: (e as { code?: string }).code, reason: (e as Error).message.split("\n")[0].slice(0, 90) }) || "failed";
        setLast(`✕ ${m}`);
        return { ok: false, reason: m };
      } finally {
        if (!keep) {   // pending_unknown: never released here (SITE refuses it); un-bumped once SITE resolves it
          bump(-1);
          if (releaseAfter) void releaseAfter.finally(() => releasePress(pressId, "filled")); else releasePress(pressId, rel);
        }
      }
    };
    return () => { delete window.__discipleTrade; removeEventListener("disciple:op", onOp); };
  }, [token, live]);

  // HOT PATH warm-up (live only): smart account clients/fees/relay + the selected presets' quotes every ~1 s, so a tap
  // signs and sends with no chain reads. Optimistic UI: "sent" the moment the op is submitted (disciple:op).
  useEffect(() => {
    if (!live) return;
    let alive = true; const pc = publicClient();
    const tick = async () => {
      if (!alive || document.hidden) return;
      try {
        // the ACTIVE amount: the custom $ when filled (what BOOST / SPACE spends), else the selected preset
        const usd = customRef.current || (ammo.usd[mode] ?? MODES[mode].usd);
        const me = await activeAddress();
        const bal = me ? await ownHint(pc, token as Address, me, 4000).catch(() => BigInt(0)) : BigInt(0);
        const sellFrac = (cfgRef.current.sells[sellSelRef.current] ?? 25) / 100;
        await Promise.all([
          shotAmountIn(pc, token as Address, "buy", usd).then((a) => warmRoute(pc, token as Address, "buy", a)),
          bal > BigInt(0) ? warmRoute(pc, token as Address, "sell", sellAmount(bal, sellFrac)) : null,
        ]);
      } catch { /* next tick */ }
    };
    warmRef.current = tick;
    void aaWarm().catch(() => undefined); void tick();
    const iv = setInterval(tick, 1000);
    // keep the relayer's trust entry for this sender fresh (server TTL 60 s) + fees/deploy state warm
    const iw = setInterval(() => { if (!document.hidden) void aaWarm().catch(() => undefined); }, 20_000);
    const sub = (e: Event) => {
      const d = (e as CustomEvent<{ phase: string; txHash?: string; pressId?: string }>).detail;
      // FLOW #145 tags disciple:op with the press id ⇒ only THAT press's line flips to "sent"; an untagged event (stack
      // without pressId) keeps the old behaviour. "error" (FLOW's terminal phase): the trade result paints the ✕ line.
      const mine = !d?.pressId || d.pressId === linePress.current;
      if (d?.phase === "submitted" && mine) setLast((l) => l.replace(/· sending…|· confirm in wallet…/, "· sent ⚡"));
      // the trade moved the price: its route quotes were dropped — re-warm right away (after the drop runs)
      if (d?.phase === "confirmed") setTimeout(() => void tick(), 0);
    };
    addEventListener("disciple:op", sub);
    return () => { alive = false; warmRef.current = async () => {}; clearInterval(iv); clearInterval(iw); removeEventListener("disciple:op", sub); };
  }, [live, token, mode, ammo.usd]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Preview for the selected ammo from on-chain views (curve quoteBuy/quoteSell, router quoteExactIn).
  useEffect(() => {
    if (!valid) return;
    let alive = true; gradRef.current = null;
    const usd = ammo.usd[mode] ?? MODES[mode].usd;
    (async () => {
      try {
        const pc = publicClient();
        const b = await readQuote(pc, token as Address, "buy", await usdToAmountIn(pc, token as Address, "buy", usd));
        if (alive) gradRef.current = { usd, graduates: b.graduates, mcapAfterUsd: b.mcapAfterUsd, venue: b.venue };   // gas kind
        const s = await readQuote(pc, token as Address, "sell", await usdToAmountIn(pc, token as Address, "sell", usd));
        if (alive) setPreview(`price move: buy ▲${b.impactPct.toFixed(2)}% · sell ▼${Math.abs(s.impactPct).toFixed(2)}%${b.snipeFee > BigInt(0) ? " · anti-snipe fee" : ""}`);
      } catch { if (alive) setPreview(""); }
    })();
    return () => { alive = false; };
  }, [mode, token, valid, ammo.usd]);

  // remembered selections: buy preset (engine S.mode, restored on boot) and sell preset (default 25% = slot 0)
  const SEL_KEY = storagePrefix + "sel";
  const [sellSel, setSellSel] = useState(DEFAULT_SELL_SEL); sellSelRef.current = sellSel;
  const [sellCustom, setSellCustom] = useState("");
  const [sellUnit, setSellUnit] = useState<"%" | "$">("%");
  const selSell = useRef<(i: number) => void>(() => {}); selSell.current = (i: number) => { setSellSel(i); try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}"); localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, sell: i, sv: 2 })); } catch { /* */ } };
  useEffect(() => { try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}");
    if (o.sell >= 0 && o.sell < 4) { const i = o.sv === 2 ? o.sell : [1, 2, 3, DEFAULT_SELL_SEL][o.sell];   // pre-10% layout: 25/50/100 shift right, INITIALS → 25%
      setSellSel(i); if (o.sv !== 2) localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, sell: i, sv: 2 })); }
    if (o.sellUnit === "$" || o.sellUnit === "%") setSellUnit(o.sellUnit); } catch { /* */ } }, [SEL_KEY]);
  const pickUnit = (u: "%" | "$") => { setSellUnit(u); try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}"); localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, sellUnit: u })); } catch { /* */ } };
  useEffect(() => {   // restore the buy selection once the engine announces its ammo, then remember every change
    let restored = false, tries = 0;   // retry until the engine (maybe still booting in its worker) echoes the saved mode
    const h = (e: Event) => { const m = (e as CustomEvent<{ mode: number }>).detail?.mode;
      try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}");
        if (!restored) { if (!(o.buy >= 0 && o.buy < MODES.length) || o.buy === m || ++tries > 20) restored = true; else { dispatchEvent(new CustomEvent("disciple:shoot", { detail: { mode: o.buy } })); setMode(o.buy); return; } }
        if (typeof m === "number" && o.buy !== m) localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, buy: m })); } catch { /* */ } };
    addEventListener("disciple:ammo", h); return () => removeEventListener("disciple:ammo", h);
  }, [SEL_KEY]);
  const dumpRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    // sell-size keys (default Z/X/C/V, rebindable in the ESC menu) are handled by the engine, which emits disciple:sellselect:
    // selector only, updates the DUMP selection/label, never trades (Shift / DUMP sells)
    const c = (e: Event) => { const i = (e as CustomEvent<{ i: number }>).detail?.i; if (i >= 0 && i < 4) selSell.current(i); };
    const d = () => dumpRef.current?.();
    addEventListener("disciple:sellselect", c); addEventListener("disciple:dump", d);
    return () => { removeEventListener("disciple:sellselect", c); removeEventListener("disciple:dump", d); };
  }, []);
  // SELL row labels/enabled → engine ammo panel
  // live: the wallet's real token balance decides whether selling is possible (polled + after each trade) → engine guard.
  // It is ALSO the PnL HUD's position (maker lee: "should be from actual wallet balance"): components/PnlHud shows this
  // balance × the mark as HOLDINGS. Read with freshSellBalance, the exact same read DUMP % sizes from, so the HUD shows what
  // DUMP sells. Refreshed on load, every 10 s, after each trade (disciple:livetrade) and when a fill's receipt lands.
  // settled = no own trade in flight / within 15 s (RPC nodes may lag): only then may the HUD shrink a stale ledger to it.
  const [liveHas, setLiveHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (!live) { setLiveHas(null); dispatchEvent(new CustomEvent("disciple:holdings", { detail: null })); return; }
    let alive = true; const pc = publicClient();
    const poll = async () => { try { const me = await activeAddress(); if (!me) return;
      const b = await freshSellBalance(() => ownBalance(pc, token as Address, me, () => tokenBalance(pc, token as Address, me)), () => ownHint(pc, token as Address, me, 60_000), lastOwnTradeAt.current);
      const inFlight = (window.__disciplePendingTrades?.buy || 0) + (window.__disciplePendingTrades?.sell || 0);
      const settled = inFlight === 0 && Date.now() - lastOwnTradeAt.current > 15_000;
      // tokens: the real balanceOf → engine S.liveBag (live % / DUMP ALL $ sizing at its mark) + PnL HUD holdings
      if (alive) { liveTokens.current = units(b); setLiveHas(b > BigInt(0)); dispatchEvent(new CustomEvent("disciple:holdings", { detail: { has: b > BigInt(0), tokens: liveTokens.current, settled } })); } } catch { /* keep last */ } };
    const tos = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number) => { const id = setTimeout(() => { tos.delete(id); void poll(); }, ms); tos.add(id); };
    // receipt landed: the ledger already holds the fill (applyOwn) ⇒ push it now (no RPC), reconcile ≥ 1 s later (block-checked)
    const fromLedger = async () => { try { const me = await activeAddress(); const b = me ? OWN.get(token as Address, me) : undefined;
      if (alive && b !== undefined) { liveTokens.current = units(b); setLiveHas(b > BigInt(0)); dispatchEvent(new CustomEvent("disciple:holdings", { detail: { has: b > BigInt(0), tokens: liveTokens.current, settled: false } })); } } catch { /* poll */ } };
    const soon = () => { void fromLedger(); later(1100); };
    const afterTrade = () => { void poll(); later(16_000); };   // now + once settled
    void poll(); const iv = setInterval(poll, 10_000);
    addEventListener("disciple:livetrade", afterTrade); addEventListener("disciple:ownbalance", soon);
    return () => { alive = false; clearInterval(iv); tos.forEach(clearTimeout); removeEventListener("disciple:livetrade", afterTrade); removeEventListener("disciple:ownbalance", soon); };
  }, [live, token]);
  // CASH for the BOOST check. Live: the trading account's USDG (the header's "cash"), polled + after each trade, also pushed
  // to the engine (disciple:cash) so SPACE is blocked the same way. Paper: the engine's paper balance (disciple:papercash).
  const [liveCash, setLiveCash] = useState<number | null>(null);
  useEffect(() => {
    if (!live) { CASH_RAW.v = null; setLiveCash(null); dispatchEvent(new CustomEvent("disciple:cash", { detail: { usd: null } })); return; }
    let alive = true; const pc = publicClient();
    const poll = async () => { try { const me = await activeAddress(); if (!me) return; const usdg = deployment().usdg;
      void warmGasPrice(pc);   // gas reserve: live gas price, off the trade path
      const [raw, dec] = await Promise.all([ownBalance(pc, usdg, me, () => balanceHint(pc, usdg, me, 4000)), decimalsOf(pc, usdg)]);
      const usd = Number(raw) / 10 ** dec;
      if (alive && Number.isFinite(usd)) { CASH_RAW.v = raw; setLiveCash(usd); dispatchEvent(new CustomEvent("disciple:cash", { detail: { usd, gasPerOpUsd: gasUsd() } })); } } catch { /* keep last */ } };
    // cash at confirm from the receipt's USDG Transfer (ledger, no RPC); reconcile ≥ 1 s later (block-checked)
    const fromLedger = async () => { try { const me = await activeAddress(); const usdg = deployment().usdg; const raw = me ? OWN.get(usdg, me) : undefined; if (raw === undefined) return;
      const usd = Number(raw) / 10 ** (await decimalsOf(pc, usdg)); if (alive && Number.isFinite(usd)) { CASH_RAW.v = raw; setLiveCash(usd); dispatchEvent(new CustomEvent("disciple:cash", { detail: { usd, gasPerOpUsd: gasUsd() } })); } } catch { /* poll */ } };
    const tos = new Set<ReturnType<typeof setTimeout>>();
    const at = (ms: number) => { const id = setTimeout(() => { tos.delete(id); void poll(); }, ms); tos.add(id); };
    const own = () => { void fromLedger(); at(1100); };
    void poll(); const iv = setInterval(poll, 5_000); const later = () => at(2500);
    addEventListener("disciple:livetrade", later); addEventListener("disciple:ownbalance", own);
    return () => { alive = false; clearInterval(iv); tos.forEach(clearTimeout); removeEventListener("disciple:livetrade", later); removeEventListener("disciple:ownbalance", own); };
  }, [live]);
  const [paperCash, setPaperCash] = useState<number | null>(null);
  useEffect(() => { const h = (e: Event) => { const u = (e as CustomEvent<{ usd: number | null }>).detail?.usd; setPaperCash(typeof u === "number" && Number.isFinite(u) ? u : null); };
    addEventListener("disciple:papercash", h); return () => removeEventListener("disciple:papercash", h); }, []);
  // the coin's mode + wallet cap (+ its ticker) → engine TIER line / MARKET CAP header (disciple:coinrules); read onchain, polled (caps can move with mcap)
  useEffect(() => {
    if (!valid) { dispatchEvent(new CustomEvent("disciple:coinrules", { detail: null })); return; }
    let alive = true; const pc = publicClient();
    const poll = async () => { try { const r = await readCoinRules(pc, token as Address); if (alive) dispatchEvent(new CustomEvent("disciple:coinrules", { detail: r })); } catch { /* keep last */ } };
    void poll(); const iv = setInterval(poll, 15_000); const again = () => { n = 0; void poll(); }; let n = 0;
    const boot = () => { if (n++ < 3) void poll(); };   // engine may boot after mount (worker): re-send on its first ammo announcements
    addEventListener("disciple:ammo", boot); addEventListener("disciple:livetrade", again);
    return () => { alive = false; clearInterval(iv); removeEventListener("disciple:ammo", boot); removeEventListener("disciple:livetrade", again); };
  }, [valid, token]);
  const has = live && liveHas != null ? liveHas : pos.size > 0;
  // in-flight trades (engine disciple:inflight, only real pending ones) + reservation changes ⇒ re-render the greyed state
  const [inFlight, setInFlight] = useState({ n: 0, max: 3 });
  const [, setResv] = useState(0);
  useEffect(() => { const h = (e: Event) => { const d = (e as CustomEvent<{ n: number; max: number }>).detail; if (d && Number.isFinite(d.n)) setInFlight({ n: d.n, max: d.max || 3 }); };
    addEventListener("disciple:inflight", h); const off = onReservations(() => setResv((x) => x + 1));
    return () => { removeEventListener("disciple:inflight", h); off(); }; }, []);
  const [hint, setHint] = useState("");
  useEffect(() => { if (!hint) return; const t = setTimeout(() => setHint(""), 1400); return () => clearTimeout(t); }, [hint]);
  const sellSig = SELLS.map((x) => x.id).join() + "|" + (has ? 1 : 0) + "|" + (pos.costBasis > 0 ? 1 : 0) + "|" + sellSel + "|" + gs.keys.sell.join();
  const pushSells = useRef(() => {});
  pushSells.current = () => { const items = toSells(cfgRef.current.sells).map((x, i) => ({ label: x.label, key: keyLabel(gs.keys.sell[i] || x.key), on: has, sel: i === sellSel }));
    dispatchEvent(new CustomEvent("disciple:sellpresets", { detail: { items } })); };
  useEffect(() => { pushSells.current(); }, [sellSig]);
  useEffect(() => { let n = 0; const h = () => { if (n++ < 3) pushSells.current(); }; addEventListener("disciple:ammo", h); return () => removeEventListener("disciple:ammo", h); }, []);   // engine may boot after mount (worker)
  const customUsd = +custom > 0 ? +custom : 0;
  // SPACE (engine) = BOOST with the ACTIVE amount: the custom $ when filled, else the selected preset (was: always the preset)
  const customRef = useRef(customUsd); customRef.current = customUsd;
  useEffect(() => { dispatchEvent(new CustomEvent("disciple:custombuy", { detail: { usd: customUsd } })); }, [customUsd]);
  // a new custom $ is warmed right away (debounced while typing), not only on the next 1 s tick
  useEffect(() => { if (!customUsd) return; const id = setTimeout(() => void warmRef.current(), 150); return () => clearTimeout(id); }, [customUsd]);
  // a new BOOST amount makes an earlier failure line ("✕ not enough cash…") stale: drop it (the engine drops its ✕ rows too)
  const amtKey = customUsd || (ammo.usd[mode] ?? MODES[mode].usd);
  useEffect(() => { setLast((l) => (l.startsWith("✕") ? "" : l)); setHint(""); }, [amtKey]);
  // every trade-bar click / key (BOOST + DUMP buttons, custom $ Enter / SPACE, custom sell Enter) goes through here
  const shoot = (side: "buy" | "sell", extra?: { usd?: number; frac?: number; all?: boolean }) =>
    (tradeClick(), window.dispatchEvent(new CustomEvent("disciple:shoot", { detail: { side, mode, ...(extra || (customUsd ? { usd: customUsd } : {})) } })));
  // sell sizing. LIVE (Fix 4): frac of the smart account's REAL balanceOf × the real mark (the bridge re-reads balanceOf before
  // quoting; this $ only labels the shot) — was the PnL ledger's value, or $0.01 for a bag the ledger didn't know (blocked by
  // the engine's MIN_SHOT guard ⇒ DUMP did nothing). The $ here is only a label: sells are never size-filtered and the chart
  // marker is resized from the decoded receipt (disciple:fillreceipt → engine @sellfill). Paper: x% of the ledger position value.
  const sellPlan = (frac: number) => {
    if (live && liveHas) { const m = markRef.current, free = Math.max(0, liveTokens.current - units(reservedTokens(token))), v = free * (m.mcap > 0 ? m.mcap / m.supply : 0);   // label = the unreserved bag (same as the sizing)
      return { usd: v > 0 ? v * frac : pos.valueUsd > 0 ? pos.valueUsd * frac : 0.01, frac }; }
    if (!(pos.valueUsd > 0)) return null;
    return { usd: pos.valueUsd * frac, frac };
  };
  const sellFrac = (frac: number) => { if (!has) { setHint("NO TOKENS IN WALLET"); return; } const p = sellPlan(Math.min(1, frac));
    if (p && p.usd > 0) shoot("sell", { usd: +Math.max(0.01, p.usd).toFixed(2), frac: p.frac, ...(p.frac >= 1 ? { all: true } : {}) }); };
  const sell = (s: Sell) => sellFrac(s.frac);
  const selSellPreset = SELLS[sellSel] || SELLS[DEFAULT_SELL_SEL];
  // custom sell: % of holdings (≤ 100) or a $ value capped at the position value; overrides the selected preset (same rule as custom buy $)
  const sellCustomN = +sellCustom > 0 ? +sellCustom : 0;
  const customSellPct = sellUnit === "%" && sellCustomN ? Math.min(100, sellCustomN) : 0;
  const customSellUsd = sellUnit === "$" && sellCustomN ? (pos.valueUsd > 0 ? Math.min(sellCustomN, pos.valueUsd) : sellCustomN) : 0;
  const dumpLabel = customSellPct ? `${+customSellPct.toFixed(2)}%` : customSellUsd ? fmtMoney(customSellUsd) : selSellPreset.label;
  dumpRef.current = () => {
    if (customSellPct) return sellFrac(customSellPct / 100);
    if (customSellUsd) { if (!has) { setHint("NO TOKENS IN WALLET"); return; } if (!(pos.valueUsd > 0)) { setHint("position value unknown: use %"); return; }
      return shoot("sell", { usd: +customSellUsd.toFixed(2), frac: Math.min(1, customSellUsd / pos.valueUsd) }); }
    sell(selSellPreset);
  };
  const fmtShot = fmtMoney;   // shared shorthand: $0.20 · $129.12 · $129.12K · $1.50M
  // Space is a game hotkey (engine: Space = BOOST). A focused BOOST/DUMP button would ALSO fire its click on the
  // same key (native button activation, not prevented from the engine worker) ⇒ two trades per press. Keyboard → engine only.
  const noKeyActivate = { onKeyDown: (e: React.KeyboardEvent) => { if (e.key === " ") e.preventDefault(); },
    onKeyUp: (e: React.KeyboardEvent) => { if (e.key === " ") e.preventDefault(); } };
  const btn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "8px 14px", borderRadius: 9, fontWeight: 800, fontSize: 13, letterSpacing: 0.5, textAlign: "center" };
  const autoUsd = DEFAULT_BUY.slice();
  const shotUsd = customUsd || (ammo.usd[mode] ?? MODES[mode].usd);
  const cashUsd = live ? liveCash : paperCash;
  // spendable = cash − Σ pending (spend + gas reserve) − this op's gas (live: the reservation registry; paper: the engine checks)
  const rawLive = live && CASH_RAW.v !== null;   // live: raw bigint compare (decimals from config); $ only for the label
  const spendable = rawLive ? rawToUsd(spendableRaw(CASH_RAW.v!)) : cashUsd;
  const short = rawLive ? !canSpend(CASH_RAW.v!, shotUsd, gasKindFor("buy", shotUsd, gradRef.current, markRef.current.mcap)) : spendable != null && spendable + 1e-9 < shotUsd;   // BOOST greyed out: the amount is more than the spendable cash
  const shortMsg = short ? `Not enough cash: ${fmtShot(shotUsd)} BOOST, you have ${fmtShot(Math.max(0, spendable ?? 0))}${inFlight.n ? ` (${inFlight.n} pending)` : ""}` : "";
  const full = inFlight.n >= inFlight.max;   // 3 in flight: BOOST + DUMP greyed until one resolves
  return (
    <>
    <AmmoTierNotice />
    <div aria-label="trade bar" data-testid="trade-bar" className="ap-bc" style={{ bottom: 14, zIndex: 31, display: "flex", flexDirection: "column", gap: 3,
      padding: "6px 8px", borderRadius: 14, background: "rgba(8,10,28,.85)", border: "1px solid rgba(255,231,163,.3)", color: "#eef0ff", fontFamily: "ui-monospace,monospace" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
        <input aria-label="custom amount" inputMode="decimal" placeholder={fmtMoney(ammo.usd[mode] ?? MODES[mode].usd)} value={custom} title="custom $: when filled it overrides the selected BUY preset for BOOST / Space (clear it to use the preset)"
          onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.repeat) { e.preventDefault(); }   // held Enter / SPACE never auto-fires
            else if ((e.key === "Enter" || e.key === " ") && customUsd) { e.preventDefault(); shoot("buy"); }   // SPACE here = BOOST the custom $ (as in game)
            else if (e.key === " ") e.preventDefault();   // no custom $ / held: never type a space into the amount
            e.stopPropagation(); }}
          style={{ width: 78, fontSize: 12, padding: "7px 8px", borderRadius: 8, border: `1px solid ${customUsd ? "#9ff3c8" : "rgba(255,255,255,.18)"}`, background: "rgba(0,0,0,.4)", color: "#fff" }} />
        <button type="button" aria-label="buy" data-testid="buy-btn" {...noKeyActivate} title={full ? COPY.inFlight : short ? shortMsg : `BOOST (Space): buy ${fmtShot(shotUsd)}${customUsd ? " — custom amount (overrides the selected preset)" : " — the selected preset"}`} aria-disabled={short || full} disabled={short || full} onClick={() => shoot("buy")} style={{ ...btn, minWidth: 116, background: "#1f6f4a", color: "#c8ffe4", opacity: short || full ? 0.4 : 1, cursor: short || full ? "not-allowed" : "pointer" }}>▲ {t("tb.boost")} {fmtShot(shotUsd)}{customUsd ? <span style={{ fontSize: 9, opacity: 0.8, fontWeight: 600 }}> {t("tb.custom")}</span> : null}</button>
        <button type="button" aria-label="sell" data-testid="sell-btn" {...noKeyActivate} title={has ? `DUMP (Shift): sell ${dumpLabel}${sellCustomN ? ` — custom ${sellUnit === "%" ? "% of holdings" : "$ (capped at position value)"}, overrides the selected preset` : " — the selected SELL preset"}` : "NO TOKENS IN WALLET"} aria-disabled={!has || full} disabled={!has || full} onClick={() => dumpRef.current?.()}
          style={{ ...btn, minWidth: 104, background: "#7a2236", color: "#ffd0dc", opacity: has && !full ? 1 : 0.4, cursor: has && !full ? "pointer" : "not-allowed" }}>▼ {t("tb.dump")} {dumpLabel}{sellCustomN ? <span style={{ fontSize: 9, opacity: 0.8, fontWeight: 600 }}> {t("tb.custom")}</span> : null}</button>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <input aria-label="custom sell amount" data-testid="custom-sell" inputMode="decimal" placeholder={sellUnit === "%" ? selSellPreset.label : "$ value"} value={sellCustom}
            title={`custom sell: ${sellUnit === "%" ? "% of holdings" : "$ value, capped at your position value"}. When filled it overrides the selected SELL preset for DUMP / Shift (clear it to use the preset)`}
            onChange={(e) => setSellCustom(e.target.value.replace(/[^\d.]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter" && e.repeat) e.preventDefault();   // held Enter never auto-fires DUMPs
            else if (e.key === "Enter" && sellCustomN) { e.preventDefault(); dumpRef.current?.(); } e.stopPropagation(); }}
            style={{ width: 58, fontSize: 12, padding: "7px 6px", borderRadius: 8, border: `1px solid ${sellCustomN ? "#ffb0c8" : "rgba(255,255,255,.18)"}`, background: "rgba(0,0,0,.4)", color: "#fff" }} />
          <button type="button" data-testid="sell-unit" aria-label={`custom sell unit: ${sellUnit}`} title="toggle: % of holdings ↔ $ value" onClick={() => pickUnit(sellUnit === "%" ? "$" : "%")}
            style={{ ...btn, padding: "6px 7px", fontSize: 11, background: "rgba(255,176,200,.14)", color: "#ffd0dc" }}>{sellUnit}</button>
        </span>
        <div style={{ display: "grid", gap: 1, fontSize: 10, lineHeight: 1.2, minWidth: 64 }}>
          <span title={live ? "wallet signs each shot" : "paper trades — connect wallet to trade"} style={{ justifySelf: "start", padding: "1px 6px", borderRadius: 5,
            background: live ? "rgba(159,243,200,.14)" : "rgba(255,231,163,.14)", color: live ? "#9ff3c8" : "#ffe7a3" }}>{live ? "LIVE" : valid ? "PAPER" : token === "SIMULATOR" ? "SIM" : "PAPER"}</span>
          <span style={{ opacity: 0.65 }}>{pos.valueUsd > 0 ? `${t("tb.pos")} ${fmtMoney(pos.valueUsd)}` : t("tb.noPos")}</span>
        </div>
      </div>
      {(hint || shortMsg) && <div data-testid="trade-hint" style={{ fontSize: 10, color: "#ffb0c8" }}>{hint || shortMsg}</div>}
      {!hint && !shortMsg && (last || preview) && <div style={{ fontSize: 10, opacity: 0.8, maxWidth: 380, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: last ? "#ffe7a3" : undefined }}>{last || preview}</div>}
    </div>
    {showCfg && <SwapSettingsModal initial={cfg} autoUsd={autoUsd} tier={ammo.tier} scope={`${live ? "live" : storagePrefix.includes("sim") ? "simulator" : "paper"} settings`}
      onClose={() => setShowCfg(false)}
      onSave={(n) => { setCfg(n); saveSettings(scope, n); setShowCfg(false); }} />}
    </>
  );
}
