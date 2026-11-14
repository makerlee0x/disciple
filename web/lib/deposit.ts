/**
 * "Send crypto instead" (Add cash board 3, maker signed off 2026-11-14): the player picks the coin they have and the
 * network it's on, and gets an address. Whatever lands there is swapped and bridged into USDG on our chain, straight
 * into their cash address, by Privy's deposit addresses (useDepositAddress from @privy-io/react-auth/hooks, Relay
 * underneath). USDG already on Robinhood Chain needs no swap: that choice shows the plain cash address.
 *
 * Like lib/fund, the Privy calls run inside the lazy Privy chunk (components/PrivyMount DepositBridge); the rest of the
 * app asks with window events. Needs "Crypto deposits" switched on in the Privy dashboard, with app-paid gas
 * sponsorship on each source chain. When a route isn't on, the call fails and Cash shows DEPOSIT_COPY.unavailable.
 */

export type CoinId = "USDC" | "USDT" | "ETH" | "SOL" | "USDG";
export type Net = { id: string; name: string; caip2: string };

/** Robinhood Chain mainnet / testnet. USDG on these needs no swap (our own coin, our own chain). */
export const RH_CAIP2 = ["eip155:4663", "eip155:46630"] as const;
const NET = {
  base: { id: "base", name: "Base", caip2: "eip155:8453" },
  eth: { id: "eth", name: "Ethereum", caip2: "eip155:1" },
  arb: { id: "arb", name: "Arbitrum", caip2: "eip155:42161" },
  op: { id: "op", name: "Optimism", caip2: "eip155:10" },
  poly: { id: "poly", name: "Polygon", caip2: "eip155:137" },
  bnb: { id: "bnb", name: "BNB Chain", caip2: "eip155:56" },
  sol: { id: "sol", name: "Solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
} satisfies Record<string, Net>;

/** The board's picks, most common first. The live list is this cut down to what Privy's config supports. */
export const DEPOSIT_COINS: ReadonlyArray<{ id: CoinId; nets: Net[] }> = [
  { id: "USDC", nets: [NET.base, NET.eth, NET.arb, NET.sol, NET.poly] },
  { id: "USDT", nets: [NET.eth, NET.arb, NET.sol, NET.bnb] },
  { id: "ETH", nets: [NET.eth, NET.base, NET.arb, NET.op] },
  { id: "SOL", nets: [NET.sol] },
  { id: "USDG", nets: [] },   // + Robinhood Chain (filled in per active chain) + Ethereum
];

export const DEPOSIT_COPY = {
  title: "Send crypto",
  coinQ: "What are you sending?",
  netQ: "From which network?",
  addrLabel: (coin: string, net: string) => `Your ${coin} address on ${net}`,
  copy: "Copy address", copied: "Copied",
  making: "Getting your address…",
  turns: "It turns into cash by itself, usually in 1 to 3 minutes.",
  turnsEta: (min: number) => `It turns into cash by itself, usually in about ${min} minute${min === 1 ? "" : "s"}.`,
  direct: "It shows up as cash as soon as it lands.",
  fee: (coin: string, net: string) => `A small swap fee comes off the amount. Send only ${coin} on ${net} to this address.`,
  directWarn: (net: string) => `Send only USDG on ${net} to this address.`,
  sent: "I sent it",
  watching: "Watching for it. You can close this, your cash shows up when it lands.",
  done: "It landed. Your cash is updated.",
  refunded: "That deposit couldn't be swapped, so it was sent back.",
  unavailable: "Sending crypto isn't on right now. You can still pay by card, or send USDG on Robinhood Chain.",
  slow: "Still waiting for it. If you sent it, your cash shows up when it lands.",
} as const;

/** Privy's DepositConfig, only the parts we read (shape-typed so tests need no SDK). */
export type DepositConfigLike = {
  currencies: Array<{ symbol: string; chains: Array<{ caip2: string; address: string; decimals: number }> }>;
};
export type DepositRoute = { coin: CoinId; net: Net; direct: boolean; sourceCurrency?: string };

/** The network list for a coin: the board's list, filtered to what the live config supports (no config = the board's
 *  list). USDG leads with our own chain, which is always direct. Pure, tested. */
export function netsFor(coin: CoinId, cfg: DepositConfigLike | null, rhCaip2: string, rhName = "Robinhood Chain"): Net[] {
  const own: Net = { id: "rh", name: rhName, caip2: rhCaip2 };
  const base = coin === "USDG" ? [own, NET.eth] : DEPOSIT_COINS.find((c) => c.id === coin)?.nets ?? [];
  if (!cfg) return base;
  const cur = cfg.currencies.find((c) => c.symbol.toUpperCase() === coin);
  const have = new Set((cur?.chains ?? []).map((c) => c.caip2));
  return base.filter((n) => n.caip2 === rhCaip2 || have.has(n.caip2));
}

/** Coins with at least one network (no config = all of them). Pure. */
export function coinsFor(cfg: DepositConfigLike | null, rhCaip2: string): CoinId[] {
  return DEPOSIT_COINS.map((c) => c.id).filter((id) => netsFor(id, cfg, rhCaip2).length > 0);
}

/** Resolve the pick to a route: direct (USDG on our chain → plain cash address) or a swap with Privy's token address.
 *  null = that pair isn't supported. Pure, tested. */
export function routeFor(coin: CoinId, net: Net, cfg: DepositConfigLike | null, rhCaip2: string): DepositRoute | null {
  if (coin === "USDG" && net.caip2 === rhCaip2) return { coin, net, direct: true };
  const cur = cfg?.currencies.find((c) => c.symbol.toUpperCase() === coin);
  const ch = cur?.chains.find((c) => c.caip2 === net.caip2);
  return ch ? { coin, net, direct: false, sourceCurrency: ch.address } : null;
}

/* ---------------- window-event calls into the Privy chunk ---------------- */

export const DEPOSIT_CALL_EVENT = "disciple:deposit-call";
export const DEPOSIT_REPLY_EVENT = "disciple:deposit-reply";
/** CustomEvent<{ id }>: DepositBridge got call `id`. With no ack the Privy chunk isn't there (Privy off, still loading or
 *  blocked) and the call fails fast, so Send crypto shows the plain cash address instead of "Getting your address…" for 20 s. */
export const DEPOSIT_ACK_EVENT = "disciple:deposit-ack";
export const DEPOSIT_ACK_MS = 4_000;
export type DepositCall =
  | { id: string; op: "config" }
  | { id: string; op: "address"; sourceChain: string; sourceCurrency: string; destinationChain: string; destinationCurrency: string; destinationAddress: string }
  | { id: string; op: "wait"; depositAddressId: string; quoteCreatedAt: string };
export type DepositReply = { id: string; ok: boolean; data?: unknown; message?: string };
export type DepositAddress = { id: string; address: string; createdAt: string; etaSec: number };
export type DepositOutcome = { status: "completed"; amount: string | null } | { status: "refunded" | "failed" | "timeout" };

type CallBody = DepositCall extends infer C ? C extends DepositCall ? Omit<C, "id"> : never : never;
let seq = 0;
function call<T>(body: CallBody, timeoutMs: number): Promise<T> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const id = `d${Date.now().toString(36)}${(seq++).toString(36)}`;
  return new Promise<T>((resolve, reject) => {
    const off = () => { window.removeEventListener(DEPOSIT_REPLY_EVENT, on); window.removeEventListener(DEPOSIT_ACK_EVENT, ack); clearTimeout(t); clearTimeout(a); };
    const on = (e: Event) => {
      const r = (e as CustomEvent<DepositReply>).detail;
      if (r?.id !== id) return;
      off();
      if (r.ok) resolve(r.data as T); else reject(new Error(r.message || "deposit call failed"));
    };
    const ack = (e: Event) => { if ((e as CustomEvent<{ id: string }>).detail?.id === id) clearTimeout(a); };
    const t = setTimeout(() => { off(); reject(new Error("timeout")); }, timeoutMs);
    const a = setTimeout(() => { off(); reject(new Error("no deposit bridge")); }, Math.min(DEPOSIT_ACK_MS, timeoutMs));
    window.addEventListener(DEPOSIT_REPLY_EVENT, on);
    window.addEventListener(DEPOSIT_ACK_EVENT, ack);
    window.dispatchEvent(new CustomEvent<DepositCall>(DEPOSIT_CALL_EVENT, { detail: { id, ...body } as DepositCall }));
  });
}

let cfgP: Promise<DepositConfigLike | null> | null = null;
/** The live config once per page (null when deposits aren't on or Privy isn't loaded). */
export function depositConfig(): Promise<DepositConfigLike | null> {
  cfgP ??= call<DepositConfigLike>({ op: "config" }, 20_000).catch(() => { cfgP = null; return null; });
  return cfgP;
}
export function depositAddress(req: Omit<Extract<DepositCall, { op: "address" }>, "id" | "op">): Promise<DepositAddress> {
  return call<DepositAddress>({ op: "address", ...req }, 30_000);
}
export function waitForDeposit(a: DepositAddress, timeoutMs = 60 * 60_000): Promise<DepositOutcome> {
  return call<DepositOutcome>({ op: "wait", depositAddressId: a.id, quoteCreatedAt: a.createdAt }, timeoutMs + 5_000);
}
