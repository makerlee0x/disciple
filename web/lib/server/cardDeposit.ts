import "server-only";
/**
 * Card / Apple Pay → Cash (maker 2026-11-20). Card sellers don't sell USDG on Robinhood Chain, so the card buys USDC on
 * Base and pays it into a Relay deposit address (relay.link, deposit-address mode, the same one Turbo cash uses in
 * lib/server/lighter/bridge) that swaps it into USDG on Robinhood Chain and sends it to the player's cash address.
 * Nobody signs or pays gas: Relay's solver fills it. No Privy deposit addresses, so no Privy gas sponsorship.
 * If a different amount lands than was quoted (the card seller's fee), Relay fills what arrived.
 */
import { parseRelayDeposit, RH_USDG, type RelayDeposit } from "@/lib/server/lighter/bridge";

const RELAY = "https://api.relay.link";
export const BASE_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RH_CHAIN = 4663;
export const CARD_MIN_USD = 5, CARD_MAX_USD = 2_000;

export class CardDepositError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Relay's /quote body for `usd` of USDC on Base → USDG in `wallet` on Robinhood Chain. Refunds go back to the same
 *  wallet on Base (the player's Privy wallet, which exists on every EVM chain). Pure, tested. */
export function cardQuoteBody(wallet: string, usd: number) {
  return {
    user: wallet, recipient: wallet, refundTo: wallet, useDepositAddress: true, tradeType: "EXACT_INPUT",
    originChainId: BASE_ID, originCurrency: BASE_USDC, destinationChainId: RH_CHAIN, destinationCurrency: RH_USDG,
    amount: String(Math.round(usd * 1e6)),
  };
}

export async function cardDepositAddress(wallet: string, usd: number, f: typeof fetch = fetch): Promise<RelayDeposit> {
  if (!(usd >= CARD_MIN_USD && usd <= CARD_MAX_USD)) throw new CardDepositError(400, `Pick $${CARD_MIN_USD} to $${CARD_MAX_USD}.`);
  const res = await f(`${RELAY}/quote`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(cardQuoteBody(wallet, usd)), signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new CardDepositError(502, (j as { message?: string }).message || "The swap service didn't answer.");
  try { return parseRelayDeposit(j); } catch { throw new CardDepositError(502, "The swap service didn't answer."); }
}
