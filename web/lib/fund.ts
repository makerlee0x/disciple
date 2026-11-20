/**
 * Card / Apple Pay on-ramp (maker, 2026-11-14: "on ramp with privy"; 2026-11-20: "we need card and apple pay set up").
 * Privy's funding flow runs inside the lazy Privy chunk (components/PrivyMount FundBridge), so the rest of the app asks
 * for it with a window event, the same way it talks to Privy for sign-in.
 *
 * Card providers (Stripe, MoonPay…) don't sell USDG on Robinhood Chain, which is why Privy's window used to show only
 * "Transfer from wallet / Receive funds". So the card buys USDC on Base and pays it into a Relay deposit address our
 * server makes (POST /api/cash/card, lib/server/cardDeposit) that swaps it into USDG on our chain, straight into the
 * player's cash address. The player signs nothing and nobody pays gas. Cash's balance poll shows it when it lands.
 *
 * Privy dashboard needs only Card onramps on (Stripe / MoonPay). Not Crypto deposits.
 */
export const FUND_EVENT = "disciple:fund";
/** CustomEvent<FundResult>: the flow closed (PrivyMount → Cash). */
export const FUND_DONE_EVENT = "disciple:fund-done";
/** Event (no detail): PrivyMount's FundBridge got the request. With no ack, nothing is listening (Privy off, its chunk
 *  still loading or blocked), so Cash says checkout isn't available instead of holding "Opening checkout…". */
export const FUND_ACK_EVENT = "disciple:fund-ack";
/** how long startFunding waits for that ack */
export const FUND_ACK_MS = 6_000;
export type FundRequest = { address: string; usd?: number };
/** closed = the player shut the checkout without paying: Cash shows nothing (maker 2026-11-20: "remove that"). */
export type FundResult = { ok: boolean; message?: string; closed?: boolean };

export const FUND_DEFAULT_USD = 25;
/** Card amount limits. $10 is the lowest the card sellers (Stripe, MoonPay) reliably take in the US; the server's Relay
 *  quote also needs $5+ after the card fee (lib/server/cardDeposit CARD_MIN_USD / CARD_MAX_USD). */
export const FUND_MIN_USD = 10, FUND_MAX_USD = 2_000;
/** What the player typed → digits and one dot, at most 2 decimals. Pure, tested. */
export function fundAmountInput(raw: string): string {
  const s = raw.replace(/[^0-9.]/g, "");
  const i = s.indexOf(".");
  return i < 0 ? s.slice(0, 5) : `${s.slice(0, Math.min(i, 5))}.${s.slice(i + 1).replace(/\./g, "").slice(0, 2)}`;
}
/** quick picks on the Add cash card button */
export const FUND_PICKS = [10, 25, 50, 100] as const;

/** "You get about": MoonPay's card fee is roughly 3 to 5%. An estimate for the board; checkout shows the real quote. */
export const FUND_CARD_FEE_EST = 0.045;

export const FUND_COPY = {
  howMuch: "How much",
  youPay: "You pay",
  youGet: "You get about",
  button: "Pay with card or Apple Pay",
  sub: "",
  or: "or",
  sendTitle: "Send USDG instead",
  sendSub: "Robinhood Chain only",
  opening: "Opening checkout…",
  done: "Payment sent. Your cash shows up in a few minutes.",
  unavailable: "Card checkout isn't available right now. You can still send crypto.",
  signIn: "Sign in to add cash.",
  min: "Minimum $10 by card.",
  max: "Maximum $2,000 by card.",
} as const;

/** Ask the Privy chunk to open its funding flow for `address`. Resolves when the flow closes. */
export function startFunding(req: FundRequest, timeoutMs = 15 * 60_000, ackMs = FUND_ACK_MS): Promise<FundResult> {
  if (typeof window === "undefined") return Promise.resolve({ ok: false, message: FUND_COPY.unavailable });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: FundResult) => { if (done) return; done = true; window.removeEventListener(FUND_DONE_EVENT, on); window.removeEventListener(FUND_ACK_EVENT, ack); clearTimeout(t); clearTimeout(a); resolve(r); };
    const on = (e: Event) => finish((e as CustomEvent<FundResult>).detail ?? { ok: false });
    const ack = () => { clearTimeout(a); };
    const t = setTimeout(() => finish({ ok: false, closed: true }), timeoutMs);
    // e2e (2026-11-14): with no FundBridge mounted the request went nowhere and the button sat on "Opening checkout…" for 15 min
    const a = setTimeout(() => finish({ ok: false, message: FUND_COPY.unavailable }), ackMs);
    window.addEventListener(FUND_DONE_EVENT, on);
    window.addEventListener(FUND_ACK_EVENT, ack);
    window.dispatchEvent(new CustomEvent<FundRequest>(FUND_EVENT, { detail: req }));
  });
}

/** Privy's error → a result: the player backing out says nothing, anything else is the one "unavailable" line. Pure, tested. */
export function fundErrorResult(e: unknown): FundResult {
  const m = String((e as { message?: string; name?: string } | null)?.message ?? e ?? "").toLowerCase();
  const name = String((e as { name?: string } | null)?.name ?? "").toLowerCase();
  if (/exit|closed|cancel|user rejected|abort|dismiss/.test(m) || /exit|abort|cancel/.test(name)) return { ok: false, closed: true };
  return { ok: false, message: FUND_COPY.unavailable };
}

/** POST /api/cash/card's answer → where the card pays, or null. Pure, tested. */
export type CardTarget = { address: string; chain: `${string}:${string}`; asset: string };
export function parseCardTarget(j: unknown): CardTarget | null {
  const o = (j ?? {}) as { ok?: boolean; address?: unknown; chain?: unknown; asset?: unknown };
  if (!o.ok || typeof o.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.address)) return null;
  if (typeof o.chain !== "string" || !/^eip155:\d+$/.test(o.chain) || typeof o.asset !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.asset)) return null;
  return { address: o.address, chain: o.chain as `${string}:${string}`, asset: o.asset };
}

/** Apple devices open on Apple Pay, the rest on card. Only a hint: Privy falls back when no quote matches. */
export function payHint(ua: string): "APPLE_PAY" | "CREDIT_DEBIT_CARD" {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua) ? "APPLE_PAY" : "CREDIT_DEBIT_CARD";
}
