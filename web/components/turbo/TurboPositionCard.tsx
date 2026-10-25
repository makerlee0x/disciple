"use client";
/** TURBO position card (GAME): every number in dollars. PnL after fees is the big number; fees are shown separately. */
import { T } from "@/lib/turbo/copy";
import { pct, price as fp, signedUsd, usd } from "@/lib/turbo/format";
import { wipeoutPctAway } from "@/lib/turbo/gameFx";

export interface CardPos { side: "long" | "short"; market: string; collateralUsd: number; leverage: number; sizeUsd: number; entry: number; liqPrice: number;
  fundingUsd: number; openFeeUsd: number; closeFeeUsdEst: number; pnlUsd: number; pnlAfterFeesUsd: number; status: string }

export default function TurboPositionCard({ p, price, compact }: { p: CardPos; price: number; compact?: boolean }) {
  const pending = p.status === "pending", up = p.pnlAfterFeesUsd >= 0;
  const row = (k: string, v: string, tid?: string, cls = "") => <div className={`tb-row ${cls}`}><span>{k}</span><b data-testid={tid}>{v}</b></div>;
  return (
    <div className={`tb-card${compact ? " compact" : ""}`} data-testid="turbo-position">
      <div className="tb-card-head">
        <span className={`tb-side ${p.side}`}>{p.side === "long" ? "▲" : "▼"} {p.side === "long" ? T.card.long : T.card.short} {p.leverage}× {p.market}</span>
        {pending && <span className="tb-pend" data-testid="turbo-pending">{T.pending}</span>}
      </div>
      <div className={`tb-big ${pending ? "" : up ? "up" : "down"}`} data-testid="turbo-pnl">{pending ? "—" : signedUsd(p.pnlAfterFeesUsd)}</div>
      <div className="tb-big-sub">{T.card.pnl}{!pending && <> · {signedUsd(p.pnlUsd)} {T.card.pnlBefore}</>}</div>
      <div className="tb-rows">
        {row(T.card.bet, usd(p.collateralUsd), "turbo-bet")}
        {row(T.card.leverage, `${p.leverage}×`)}
        {row(T.card.size, usd(p.sizeUsd, 0), "turbo-size")}
        {row(T.card.entry, pending ? "…" : fp(p.entry))}
        {row(T.card.now, fp(price), "turbo-now")}
        {row(T.card.wipeout, pending ? "…" : `${fp(p.liqPrice)} · ${pct(wipeoutPctAway(p.side, price, p.liqPrice), 3)} ${T.card.away}`, "turbo-wipeout", "danger")}
        {row(T.card.funding, signedUsd(p.fundingUsd, 3))}
        {row(T.card.openFee, usd(p.openFeeUsd))}
        {row(T.card.closeFee, usd(p.closeFeeUsdEst))}
      </div>
      {!compact && <div className="tb-card-foot">{T.card.loseAll} ({usd(p.collateralUsd)}).</div>}
    </div>
  );
}
