/**
 * Top-right wallet balance line. On a coin page the HELD coin comes first and the coin's quote token is marked as
 * what trades spend; ETH is only gas (self-pay smart account). mUSDG is shown but is NOT spent by trades today:
 * buys spend the coin's quote token (e.g. STRATEGY) — there is no mUSDG → quote hop yet.
 */
export type BalancePart = { symbol: string; amount: number; role?: "held" | "spend" | "gas" | "other" };

const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`
  : n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 2 });

export function balanceLine(parts: BalancePart[], o: { payUsdg?: boolean } = {}): { text: string; title: string } {
  const order = { held: 0, spend: 1, other: 2, gas: 3 } as const;
  const ps = [...parts].sort((a, b) => order[a.role ?? "other"] - order[b.role ?? "other"]);
  const text = ps.map((p) => `${p.role === "gas" ? p.amount.toFixed(4) : fmt(p.amount)} ${p.role === "held" ? "$" + p.symbol : p.symbol}${p.role === "spend" ? " (pays trades)" : p.role === "gas" ? " (gas)" : ""}`).join(" · ");
  const held = ps.find((p) => p.role === "held"), spend = ps.find((p) => p.role === "spend");
  const title = [
    held && `$${held.symbol}: the coin you hold on this page.`,
    spend && (o.payUsdg ? `${spend.symbol}: what every trade spends and pays out in — the swap to this coin's pair happens in the same transaction.`
      : `${spend.symbol}: this coin's pair token — BOOST spends it, DUMP pays out in it.`),
    "ETH: gas only (your smart account self-pays).",
    !o.payUsdg && ps.some((p) => p.symbol === "mUSDG") && "mUSDG: test dollars; not spent by trades yet (no mUSDG→pair swap).",
  ].filter(Boolean).join("\n");
  return { text, title };
}
