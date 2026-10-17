/**
 * The three "How DISCIPLE works" steps (copy approved by lee). Shared by the first-visit modal and the /how-it-works
 * placeholder page. Server-safe (no hooks). Each body line renders as its own block, so step 2's
 * "BOOST = BUY & DUMP = SELL" always sits on a second line regardless of width.
 */
import Icon from "@/components/icons/Icon";
import type { IconName } from "@/components/icons/Icon";
import s from "./howItWorks.module.css";

export const HIW_STEPS: { icon: IconName; title: string; body: string[] }[] = [
  { icon: "base-pair", title: "Pick your coin.", body: ["Launch a rocket paired with any coin you believe in. Your rocket trades in that coin."] },
  { icon: "boost", title: "BOOST to climb.", body: ["Every BOOST lifts the rocket. Every DUMP drops a bomb.", "BOOST = BUY & DUMP = SELL"] },
  { icon: "lock", title: "Send your coin to The Moon and beyond.", body: ["Rockets graduate from a bonding curve. Their liquidity is locked in a Uniswap v4 LP, forever."] },
];

export default function HowItWorksSteps({ id, className }: { id?: string; className?: string }) {
  return (
    <ol id={id} className={`${s.steps}${className ? " " + className : ""}`}>
      {HIW_STEPS.map((st, i) => (
        <li key={st.title} className={s.step}>
          <span className={s.n} aria-hidden><em>{i + 1}</em><Icon name={st.icon} size={22} /></span>
          <div>
            <h3>{st.title}</h3>
            <p>{st.body.map((line) => <span key={line} className={s.line}>{line}</span>)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
