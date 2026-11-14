/**
 * Card / Apple Pay on-ramp (maker, 2026-11-14: "on ramp with privy"). Privy's funding flow (useFundWallet) runs inside the
 * lazy Privy chunk (components/PrivyMount FundBridge), so the rest of the app asks for it with a window event, the same way
 * it talks to Privy for sign-in. The flow buys USDG on the active chain straight into the player's cash address.
 *
 * Needs "Funding" switched on in the Privy dashboard (card provider + Robinhood Chain USDG). When it isn't, or the card
 * provider doesn't cover the chain, Privy throws and Cash shows FUND_COPY.unavailable next to the address, which always works.
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
export type FundResult = { ok: boolean; message?: string };

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
  sub: "Checkout by MoonPay. Lands in a few minutes.",
  or: "or",
  sendTitle: "Send crypto instead",
  sendSub: "From an exchange or wallet. Any coin works.",
  opening: "Opening checkout…",
  done: "Payment sent. Your cash shows up in a few minutes.",
  closed: "Checkout closed. If you paid, your cash shows up in a few minutes.",
  unavailable: "Card checkout isn't available right now. You can still send USDG to your address below.",
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
    const t = setTimeout(() => finish({ ok: false, message: FUND_COPY.closed }), timeoutMs);
    // e2e (2026-11-14): with no FundBridge mounted the request went nowhere and the button sat on "Opening checkout…" for 15 min
    const a = setTimeout(() => finish({ ok: false, message: FUND_COPY.unavailable }), ackMs);
    window.addEventListener(FUND_DONE_EVENT, on);
    window.addEventListener(FUND_ACK_EVENT, ack);
    window.dispatchEvent(new CustomEvent<FundRequest>(FUND_EVENT, { detail: req }));
  });
}

/** Privy's error → one plain line. Pure, tested. */
export function fundErrorLine(e: unknown): string {
  const m = String((e as { message?: string } | null)?.message ?? e ?? "").toLowerCase();
  if (/exit|closed|cancel|user rejected|abort|dismiss/.test(m)) return FUND_COPY.closed;
  return FUND_COPY.unavailable;
}
