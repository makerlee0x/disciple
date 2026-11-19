/**
 * /how-it-works ("How to play"). One tab per game mode (maker 2026-11-18): Launch, Duel, Climb, Daily mission. Each tab is a 3-step strip
 * drawn in the game's own UI pieces (what you press, what happens, how you win), the keys, and a play button. Show, don't
 * tell: every step is a picture with a verb and one short line. The Pro spec sheet still opens on #pro.
 * Both the tabs and the spec sheet render on the server; ModeTabs only picks which one shows. Strings: content/how-it-works.ts.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { withBase } from "@/lib/base-path";
import { HIW_DIFFS, HIW_DIFFS_TAG, HIW_FINAL, HIW_GAMES, HIW_H1, HIW_HOST, HIW_META, HIW_ORBIT, HIW_PRO, HIW_ROUTES, type HiwGame } from "@/content/how-it-works";
import { PRO_HUD_ENABLED } from "@/lib/features";
import ModeTabs from "./ModeTabs";
import s from "./page.module.css";

export const metadata: Metadata = { title: HIW_META.title, description: HIW_META.description };
export const dynamic = "force-static";

const ROCKET = "/assets/rocket-hi.webp";
const Rocket = ({ className }: { className?: string }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={withBase(ROCKET)} alt="" className={`${s.rkt} ${className ?? ""}`} width={60} height={160} />
);

/** The little drawings above each step, built from the game's own pieces (buttons, bag card, clock, level rows). */
function Art({ kind }: { kind: string }) {
  switch (kind) {
    // Launch steps sit on the game's cinematic plates (maker 2026-11-18: better images than a sprite on a sky)
    case "board": return (
      <div className={`${s.art} ${s.plate}`} style={{ backgroundImage: `url(${withBase("/art/launch/live.webp")})` }}>
        <span className={`${s.fire} ${s.fireBoost} ${s.artBtn}`}>▲ Boost $25</span>
      </div>
    );
    case "climb": return (
      <div className={`${s.art} ${s.plate}`} style={{ backgroundImage: `url(${withBase("/art/lobby/how-it-plays.webp")})` }}>
        <span className={`${s.bagCard} ${s.bagPlate}`}><small>Your bag</small><b>$31.20</b><em>+$6.20</em></span>
      </div>
    );
    case "cash": return (
      <div className={`${s.art} ${s.plate}`} style={{ backgroundImage: `url(${withBase("/art/how-to-play/hero.webp")})` }}>
        <span className={`${s.fire} ${s.fireDump} ${s.artBtn}`}>▼ Dump all</span>
        <span className={s.cashPop}><small>Cash</small><b>+$6.20</b></span>
      </div>
    );
    case "versus": return (
      <div className={s.art}>
        <div className={s.vs}><Rocket className={s.rVs} /><b>VS</b><Rocket className={`${s.rVs} ${s.rRival}`} /></div>
        <span className={s.ticker}>BTC <b>$97,420</b></span>
      </div>
    );
    case "call": return (
      <div className={`${s.art} ${s.artCol}`}>
        <span className={s.callRow}><span className={`${s.fire} ${s.fireBoost}`}>▲ Boost</span><i className={s.up}>BTC ↑</i></span>
        <span className={s.callRow}><span className={`${s.fire} ${s.fireDump}`}>▼ Dump</span><i className={s.down}>BTC ↓</i></span>
      </div>
    );
    case "clock": return (
      <div className={`${s.art} ${s.artCol}`}>
        <b className={s.clock}>0:00</b>
        <span className={s.score}><span className={s.me}>You <b>+$4.20</b></span><span>Rival <b>+$1.10</b></span></span>
      </div>
    );
    case "level": return (
      <div className={`${s.art} ${s.artCol}`}>
        <span className={s.lvl}><b>Level 1</b><span><i>$12 fuel</i><i>10×</i><i>1 min</i></span></span>
      </div>
    );
    case "target": return (
      <div className={`${s.art} ${s.artCol}`}>
        <span className={s.tgt}><small>Target</small><b>+1%</b></span>
        <span className={s.tbar}><i /></span>
      </div>
    );
    case "today": return (
      <div className={`${s.art} ${s.plate}`} style={{ backgroundImage: `url(${withBase("/art/modes/free.webp")})` }}>
        <span className={`${s.bagCard} ${s.bagPlate}`}><small>Practice cash</small><b>$250</b><em>2:00</em></span>
      </div>
    );
    case "rank": return (
      <div className={`${s.art} ${s.artCol}`}>
        <span className={s.score}><span className={s.me}>#1 You <b>+$84.20</b></span><span>#2 <b>+$61.05</b></span></span>
      </div>
    );
    case "ladder": return (
      <div className={s.art}>
        <ol className={s.ladder} aria-hidden>
          {[1, 2, 3, 4, 5].map((n) => <li key={n} className={n <= 2 ? s.done : ""}>{n}</li>)}
          <li className={s.free}>Free</li>
        </ol>
      </div>
    );
    default: return <div className={s.art} />;
  }
}

function Game({ g }: { g: HiwGame }) {
  return (
    <>
      <ol className={s.steps}>
        {g.steps.map((st, i) => (
          <li key={st.title} className={s.step}>
            <Art kind={st.art} />
            <div className={s.stepTx}>
              <span className={s.co} aria-hidden>{i + 1}</span>
              <div><h3>{st.title}</h3><p>{st.line}</p></div>
            </div>
          </li>
        ))}
      </ol>

      <div className={s.win}>
        <span className={s.winOk}><i aria-hidden>✓</i>{g.win.ok}</span>
        <span className={s.winBad}><i aria-hidden>✕</i>{g.win.bad}</span>
      </div>

      {g.id === "launch" && (
        <div className={s.extra}>
          <div className={s.orbit}><span>{HIW_ORBIT.k}</span><b>{HIW_ORBIT.v}</b><p>{HIW_ORBIT.line}</p></div>
          <div className={s.diffWrap}>
          <ul className={s.diffs}>
            {HIW_DIFFS.map((d) => <li key={d.id} className={s[`m_${d.id}`]}><b>{d.badge}</b><span>{d.stat}</span></li>)}
          </ul>
          <span className={s.diffTag}>{HIW_DIFFS_TAG}</span>
          </div>
        </div>
      )}

      <div className={s.keys}>
        {g.keys.map((k) => (
          <div key={k.k} className={`${s.keyGrp} ${s[`k_${k.tone}`]}`}>
            <b>{k.k}</b>
            <span>{k.keys.map(([x, v]) => (
              <span key={x} className={s.kc}><kbd className={`${s.kb} ${x.length > 1 ? s.kbWide : ""}`}>{x}</kbd><small>{v}</small></span>
            ))}</span>
          </div>
        ))}
      </div>

      <div className={s.play}>
        <Link href={g.cta.href} className={`${s.btn} ${s.gold}`} data-testid={`hiw-play-${g.id}`}>{g.cta.label}</Link>
        {g.id === "launch" && <span className={s.host}>{HIW_HOST.text} <Link href={HIW_ROUTES.launch}>{HIW_HOST.link}</Link></span>}
      </div>
    </>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return <dl className={s.kvs}>{rows.map(([k, v]) => <div key={k} className={s.kv}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function Pro() {
  const R = HIW_PRO;
  return (
    <section className={s.specs}>
      <div className={s.spec}><h3>{R.market.title}</h3><Rows rows={R.market.rows} /></div>
      <div className={s.spec}><h3>{R.fees.title}</h3><Rows rows={R.fees.rows} /></div>
      <div className={`${s.spec} ${s.wide}`}>
        <h3>{R.modes.title}</h3>
        <div className={s.tblWrap}>
          <table className={s.tbl}>
            <thead><tr><td />{R.modes.cols.map((c, i) => <th key={c} scope="col" className={s[`t${i}`]}>{c}</th>)}</tr></thead>
            <tbody>
              {R.modes.rows.map(([k, ...v]) => <tr key={k}><th scope="row">{k}</th>{v.map((x, i) => <td key={i}>{x}</td>)}</tr>)}
              <tr><th scope="row">{R.modes.overcap[0]}</th><td colSpan={3}>{R.modes.overcap[1]}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className={s.spec}><h3>{R.turbo.title}</h3><Rows rows={R.turbo.rows} /></div>
      <div className={s.spec}><h3>{R.anon.title}</h3><Rows rows={R.anon.rows} /></div>
      {PRO_HUD_ENABLED && <div className={s.spec}><h3>{R.hud.title}</h3><Rows rows={R.hud.rows} /></div>}
      <div className={`${s.spec}${PRO_HUD_ENABLED ? "" : ` ${s.wide}`}`}>
        <h3>{R.keys.title}</h3>
        <dl className={s.kvs}>
          {R.keys.rows.map((r) => (
            <div key={r.k} className={s.kv}><dt>{r.k}</dt><dd>{r.keys.map((k) => <kbd key={k} className={s.kb}>{k}</kbd>)}{r.v && <span>{r.v}</span>}</dd></div>
          ))}
        </dl>
      </div>
      <div className={`${s.verify} ${s.wide}`}>
        <b>{R.verify.title}</b>
        {R.verify.body && <span>{R.verify.body}</span>}
        <Link href={HIW_ROUTES.contracts} className={`${s.btn} ${s.ghost} ${s.sm}`}>{R.verify.contracts}</Link>
        <Link href={HIW_ROUTES.docs} className={`${s.btn} ${s.ghost} ${s.sm}`}>{R.verify.docs}</Link>
      </div>
    </section>
  );
}

export default function HowItWorksPage() {
  return (
    <main className={s.page}>
      <ModeTabs
        h1={HIW_H1}
        games={HIW_GAMES.map((g) => ({ id: g.id, tab: g.tab, tag: g.tag, art: withBase(g.art), tone: g.tone, body: <Game g={g} /> }))}
        pro={{ h1: HIW_PRO.h1, body: <Pro /> }}
      />

      <footer className={s.footer}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG lockup, no optimisation needed */}
        <img src={withBase("/brand/disciple-lockup-horizontal-light.svg")} alt={HIW_FINAL.logoAlt} width={146} height={31} loading="lazy" />
        <span className={s.sp} />
        <span className={s.footLinks}>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/risk">Risk</Link>
          <Link href="/security">Security</Link>
        </span>
      </footer>
    </main>
  );
}
