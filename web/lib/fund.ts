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
export type FundRequest = { address: string; usd?: number };
export type FundResult = { ok: boolean; message?: string };

export const FUND_DEFAULT_USD = 25;
/** quick picks on the Add cash card button */
export const FUND_PICKS = [10, 25, 50, 100] as const;

export const FUND_COPY = {
  button: "Buy with card or Apple Pay",
  sub: "Lands as cash in a few minutes.",
  or: "Or send USDG yourself",
  opening: "Opening checkout…",
  done: "Payment sent. Your cash shows up in a few minutes.",
  closed: "Checkout closed. If you paid, your cash shows up in a few minutes.",
  unavailable: "Card checkout isn't available right now. You can still send USDG to your address below.",
  signIn: "Sign in to add cash.",
} as const;

/** Ask the Privy chunk to open its funding flow for `address`. Resolves when the flow closes. */
export function startFunding(req: FundRequest, timeoutMs = 15 * 60_000): Promise<FundResult> {
  if (typeof window === "undefined") return Promise.resolve({ ok: false, message: FUND_COPY.unavailable });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: FundResult) => { if (done) return; done = true; window.removeEventListener(FUND_DONE_EVENT, on); clearTimeout(t); resolve(r); };
    const on = (e: Event) => finish((e as CustomEvent<FundResult>).detail ?? { ok: false });
    const t = setTimeout(() => finish({ ok: false, message: FUND_COPY.closed }), timeoutMs);
    window.addEventListener(FUND_DONE_EVENT, on);
    window.dispatchEvent(new CustomEvent<FundRequest>(FUND_EVENT, { detail: req }));
  });
}

/** Privy's error → one plain line. Pure, tested. */
export function fundErrorLine(e: unknown): string {
  const m = String((e as { message?: string } | null)?.message ?? e ?? "").toLowerCase();
  if (/exit|closed|cancel|user rejected|abort|dismiss/.test(m)) return FUND_COPY.closed;
  return FUND_COPY.unavailable;
}
