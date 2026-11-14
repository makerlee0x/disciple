/**
 * /how-it-works ("How to play", canvas boards "How to play: Pilot tab" and "How to play: Pro tab"). A Pilot / Pro switch:
 * Pilot teaches a first flight on an annotated flight screen (the HUD is an illustration, not live data), Pro is a spec
 * sheet of the contract numbers. Both panels render on the server; ModeTabs only toggles which one shows (#pro opens Pro).
 * Every string comes from content/how-it-works.ts.
 */
import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { withBase } from "@/lib/base-path";
import { skySrc } from "@/lib/home/trending";
import { HIW_FINAL, HIW_META, HIW_PILOT, HIW_PRO, HIW_ROUTES } from "@/content/how-it-works";
import { PRO_HUD_ENABLED } from "@/lib/features";
import ModeTabs from "./ModeTabs";
import s from "./page.module.css";

export const metadata: Metadata = { title: HIW_META.title, description: HIW_META.description };
export const dynamic = "force-static";

const ROCKET = "/assets/rocket-hi.webp";
const sky = (t: number) => ({ backgroundImage: `url(${withBase(skySrc(t))})` }) as CSSProperties;
const Co = ({ n, className }: { n: number; className?: string }) => <span className={`${s.co} ${className ?? ""}`} aria-hidden>{n}</span>;

function Rows({ rows }: { rows: [string, string][] }) {
  return <dl className={s.kvs}>{rows.map(([k, v]) => <div key={k} className={s.kv}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function Pilot() {
  const P = HIW_PILOT, S = P.screen;
  return (
    <>
      <section className={s.flight}>
        <figure className={s.screen} style={sky(4)} aria-label={S.alt}>
          <span className={s.tag}>{S.tag}</span>
          <div className={`${s.hud} ${s.alt}`}>
            <span className={s.hk}>{S.altitude.k}</span>
            <b className={s.hv}>{S.altitude.v}</b>
            <span className={s.obar}><i style={{ width: `${S.altitude.fill * 100}%` }} /></span>
            <span className={s.orbit}>{S.altitude.orbit}</span>
            <Co n={1} className={s.c1} />
          </div>
          <div className={`${s.hud} ${s.bag}`}>
            <span className={s.hk}>{S.bag.k}</span>
            <b className={s.hv}>{S.bag.v}</b>
            <span className={s.put}>{S.bag.put} · <em>{S.bag.gain}</em></span>
            <Co n={2} className={s.c2} />
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(ROCKET)} alt="" className={s.rocket} width={110} height={300} />
          <span className={s.plume} aria-hidden />
          <span className={`${s.float} ${s.fBoost}`}>{S.boost}</span>
          <span className={`${s.float} ${s.fBomb}`}><Co n={3} className={s.c3} />{S.bomb}</span>
          <div className={`${s.hud} ${s.bar}`}>
            <div className={s.side}>
              {S.buys.map(([k, v], i) => <span key={k} className={`${s.amt} ${i === 1 ? s.amtBuy : ""}`}><kbd>{k}</kbd>{v}</span>)}
              <span className={`${s.fire} ${s.fireBoost}`}>{S.boostBtn} <kbd>Space</kbd></span>
            </div>
            <div className={s.side}>
              {S.sells.map(([k, v], i) => <span key={k} className={`${s.amt} ${i === 1 ? s.amtSell : ""}`}><kbd>{k}</kbd>{v}</span>)}
              <span className={`${s.fire} ${s.fireDump}`}>{S.dumpBtn} <kbd>Shift</kbd></span>
            </div>
            <Co n={4} className={s.c4} />
            <Co n={5} className={s.c5} />
          </div>
        </figure>
        <ol className={s.legend}>
          {P.legend.map((l, i) => (
            <li key={l.title}><span className={s.co} aria-hidden>{i + 1}</span><div><b>{l.title}</b><p>{l.body}</p></div></li>
          ))}
          <li className={s.phone}>{P.phone}</li>
        </ol>
      </section>

      <section className={s.sec} aria-labelledby="hiw-rules">
        <span className={s.eb}>{P.rules.eyebrow}</span>
        <h2 className={s.h2} id="hiw-rules">{P.rules.h2}</h2>
        <div className={s.res}>
          {P.rules.cards.map((c) => (
            <div key={c.id} className={`${s.rc} ${s[`rc_${c.id}`]}`}><span className={s.rk}>{c.k}</span><h3>{c.title}</h3><p>{c.body}</p></div>
          ))}
        </div>
        <ul className={s.modes}>
          {P.modes.map((m) => (
            <li key={m.id} className={`${s.mode} ${s[`m_${m.id}`]}`}><b>{m.badge}</b><span><strong>{m.title}</strong>{m.body}</span></li>
          ))}
        </ul>
        <p className={s.host}>{P.host.text} <Link href={HIW_ROUTES.launch}>{P.host.link}</Link></p>
      </section>
    </>
  );
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
      {PRO_HUD_ENABLED && <div className={s.spec}><h3>{R.hud.title}</h3><Rows rows={R.hud.rows} /></div>}
      <div className={s.spec}>
        <h3>{R.keys.title}</h3>
        <dl className={s.kvs}>
          {R.keys.rows.map((r) => (
            <div key={r.k} className={s.kv}><dt>{r.k}</dt><dd>{r.keys.map((k) => <kbd key={k} className={s.kb}>{k}</kbd>)}{r.v && <span>{r.v}</span>}</dd></div>
          ))}
        </dl>
      </div>
      <div className={`${s.verify} ${s.wide}`}>
        <b>{R.verify.title}</b>
        <span>{R.verify.body}</span>
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
        pilot={{ eyebrow: HIW_PILOT.eyebrow, h1: HIW_PILOT.h1, sub: HIW_PILOT.sub, body: <Pilot /> }}
        pro={{ eyebrow: HIW_PRO.eyebrow, h1: HIW_PRO.h1, sub: HIW_PRO.sub, body: <Pro /> }}
        finalStyle={sky(1)}
        final={<>
          <h2 id="hiw-final">{HIW_FINAL.h2}</h2>
          <p>{HIW_FINAL.sub}</p>
          <div className={s.ctas}>
            <Link href={HIW_ROUTES.sim} className={`${s.btn} ${s.ghost}`}>{HIW_FINAL.sim}</Link>
            <Link href={HIW_ROUTES.explore} className={`${s.btn} ${s.gold}`}>{HIW_FINAL.explore}</Link>
            <Link href={HIW_ROUTES.launch} className={`${s.btn} ${s.ghost}`}>{HIW_FINAL.launch}</Link>
          </div>
        </>}
      />

      <footer className={s.footer}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG lockup, no optimisation needed */}
        <img src={withBase("/brand/disciple-lockup-horizontal-light.svg")} alt={HIW_FINAL.logoAlt} width={146} height={31} loading="lazy" />
        <span className={s.sp} />
        <span>{HIW_FINAL.footer}</span>
        <span className={s.footLinks}>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/risk">Risk</Link>
          <Link href="/security">Security</Link>
        </span>
        {/* coin page price chart = TradingView lightweight-charts (Apache-2.0); its in-chart logo is off, credited here */}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
      </footer>
    </main>
  );
}
