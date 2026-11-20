/**
 * Card / Apple Pay on-ramp (maker, 2026-11-14: "on ramp with privy"; 2026-11-20: "we need card and apple pay set up").
 * Privy's funding flow runs inside the lazy Privy chunk (components/PrivyMount FundBridge), so the rest of the app asks
 * for it with a window event, the same way it talks to Privy for sign-in.
 *
 * Card providers (Coinbase, MoonPay, Stripe…) don't sell USDG on Robinhood Chain, which is why Privy's window used to
 * show only "Transfer from wallet / Receive funds". So the card buys USDC on Base (else Arbitrum, Polygon, Ethereum:
 * cardSource) and pays it into a fresh Privy deposit address (Relay underneath, the same one "Send crypto" uses) that
 * swaps it into USDG on our chain, straight into the player's cash address. The player signs nothing.
 *
 * Privy dashboard needs: Funding → card on-ramp on (with Apple Pay), and Crypto deposits on. When either is off the
 * call fails and Cash shows FUND_COPY.unavailable.
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
  sendTitle: "Send crypto instead",
  sendSub: "Any coin works",
  opening: "Opening checkout…",
  done: "Payment sent. Your cash shows up in a few minutes.",
  landed: "It landed. Your cash is updated.",
  unavailable: "Card checkout isn't available right now. You can still send crypto.",
  signIn: "Sign in to add cash.",
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

/** Where the card buys: USDC on the first of these the deposit config can turn into USDG. Base first: every card
 *  provider sells USDC there, Apple Pay included, and fees are lowest. */
export const CARD_SOURCE_CHAINS = ["eip155:8453", "eip155:42161", "eip155:137", "eip155:1"] as const;
type CfgLike = { currencies: Array<{ symbol: string; chains: Array<{ caip2: string; address: string; can_be_relay_deposit_source?: boolean }> }> };
/** The USDC the card buys and the chain it lands on, or null when the config has none of CARD_SOURCE_CHAINS. Pure, tested. */
export function cardSource(cfg: CfgLike | null | undefined): { chain: string; usdc: string } | null {
  const usdc = cfg?.currencies.find((c) => c.symbol.toUpperCase() === "USDC");
  for (const chain of CARD_SOURCE_CHAINS) {
    const c = usdc?.chains.find((x) => x.caip2 === chain && x.can_be_relay_deposit_source !== false);
    if (c?.address) return { chain, usdc: c.address };
  }
  return null;
}

/** Apple devices open on Apple Pay, the rest on card. Only a hint: Privy falls back when no quote matches. */
export function payHint(ua: string): "APPLE_PAY" | "CREDIT_DEBIT_CARD" {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua) ? "APPLE_PAY" : "CREDIT_DEBIT_CARD";
}
