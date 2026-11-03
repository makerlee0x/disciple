/**
 * The three "How DISCIPLE works" steps (copy approved by lee). Used by the first-visit modal; its TradeLegend is also
 * reused on the /how-it-works page. Server-safe (no hooks). Step 2's second line is an icon legend (BOOST = BUY · DUMP = SELL) using the
 * same boost/dump icons and colours as the trade buttons; each line is its own block so it never relies on wrapping.
 * Non-breaking spaces keep short tails ("Every DUMP drops a bomb.", "The Moon", "LP, forever.") from being stranded on their own line.
 */
import type { ReactNode } from "react";
import Icon from "@/components/icons/Icon";
import type { IconName } from "@/components/icons/Icon";
import s from "./howItWorks.module.css";

const NB = "\u00a0";

/** BOOST = BUY · DUMP = SELL icon legend. Also used by the /how-it-works page (size "lg" under the game section H2). */
export function TradeLegend({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  return (
    <span className={`${s.legend}${size === "lg" ? " " + s.legendLg : ""}${className ? " " + className : ""}`}>
      <span className={`${s.chip} ${s.chipBoost}`} role="note" aria-label="BOOST equals BUY">
        <Icon name="boost" size={size === "lg" ? 16 : 14} /><span aria-hidden>BOOST <i>=</i> BUY</span>
      </span>
      <span className={s.legendSep} aria-hidden />
      <span className={`${s.chip} ${s.chipDump}`} role="note" aria-label="DUMP equals SELL">
        <Icon name="dump" size={size === "lg" ? 16 : 14} /><span aria-hidden>DUMP <i>=</i> SELL</span>
      </span>
    </span>
  );
}

export const HIW_STEPS: { icon: IconName; title: string; body: ReactNode[] }[] = [
  { icon: "base-pair", title: "Pick your coin.", body: [`Launch a rocket paired with any coin you believe in. Your rocket trades in${NB}that${NB}coin.`] },
  { icon: "boost", title: "BOOST to climb.", body: [`Every BOOST lifts the rocket. Every${NB}DUMP${NB}drops${NB}a${NB}bomb.`, <TradeLegend key="legend" />] },
  { icon: "lock", title: `Send your coin to The${NB}Moon and beyond.`, body: [`If rockets ascend from the bonding curve, their liquidity is locked in a Uniswap v4${NB}LP,${NB}forever.`] },
];

export default function HowItWorksSteps({ id, className }: { id?: string; className?: string }) {
  return (
    <ol id={id} className={`${s.steps}${className ? " " + className : ""}`}>
      {HIW_STEPS.map((st, i) => (
        <li key={st.title} className={s.step}>
          <span className={s.n} aria-hidden><em>{i + 1}</em><Icon name={st.icon} size={22} /></span>
          <div>
            <h3>{st.title}</h3>
            <p>{st.body.map((line, k) => <span key={k} className={s.line}>{line}</span>)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
