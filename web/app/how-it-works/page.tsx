/**
 * /how-it-works: BRAND's r1 mockup (PLACEHOLDER; copy will change). Every string comes from content/how-it-works.ts.
 * Sections: hero · 01 pair · 02 game · 03 curve vs Uniswap · 04 difficulties (Simulator) · 05 fees · 06 FAQ · CTA.
 * Server component; the only client JS is the in-page nav, the FAQ accordion and the lazy chart mounts.
 * Hero (perf pass): static HTML with its critical CSS inlined (./hero.ts), a blur-up sky (inline LQIP background, then a
 * <picture> of the BRAND perf-hiw AVIF/WebP plates, preloaded per breakpoint), plain <a> CTAs and no entrance fade.
 * Below-the-fold sky plates reuse the tier WebPs from PR #85 (public/home/sky) and lazy-load; sections skip rendering
 * until near the viewport (content-visibility) and the charts mount on approach (LazyMount).
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import Icon, { OrbMeter, type BombTier } from "@/components/icons/Icon";
import { TradeLegend } from "@/components/home/HowItWorksSteps";
import SubNav from "@/components/how-it-works/SubNav";
import Faq from "@/components/how-it-works/Faq";
import { LazyCurveChart, LazySnipeChart, LazySpark } from "@/components/how-it-works/LazyCharts";
import { withBase } from "@/lib/base-path";
import { skySrc } from "@/lib/home/trending";
import {
  HIW_FAQ, HIW_FEES, HIW_FINAL, HIW_GAME, HIW_HERO, HIW_META, HIW_MODES, HIW_PAIR, HIW_PHASES, HIW_ROUTES, type HiwItem,
} from "@/content/how-it-works";
import { geistMono } from "./fonts";
import { HERO_CSS, MQ_DESKTOP, MQ_MOBILE, ROCKET, SIZES_DESKTOP, SIZES_MOBILE, SKY as HERO_SKY } from "./hero";
import s from "./page.module.css";

export const metadata: Metadata = { title: HIW_META.title, description: HIW_META.description };
/** Fully static: prerendered at build time and served from the CDN/edge cache. */
export const dynamic = "force-static";

/** Below-the-fold sky plates (tier index into public/home/sky): Heavenly Host (flight card), Morning Stars (CTA). */
const SKY = { flight: skySrc(7), final: skySrc(6) };

function Head({ n, eyebrow, h2, id }: { n: string; eyebrow: string; h2: string; id: string }) {
  return (
    <>
      <p className={s.eyebrow}><span className={s.n}>{n}</span><span className={s.rule} aria-hidden />{eyebrow}</p>
      <h2 className={s.h2} id={id}>{h2}</h2>
    </>
  );
}

function Items({ items }: { items: HiwItem[] }) {
  return (
    <ul className={s.items}>
      {items.map((it) => (
        <li key={it.title} className={`${s.card} ${s.item}`}>
          <span className={s.ib} aria-hidden><Icon name={it.icon} size={20} /></span>
          <h3>{it.title}</h3>
          <p>{it.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** Sky-plate rocket with a CSS plume (decorative). AVIF with WebP fallback, 108w/163w (1x/2x+ at the 190px height).
 * The hero copy is eager but fetchPriority=low so it never competes with the LCP sky plate. */
function Rocket({ h, className, lean = 0, eager = false }: { h: number; className?: string; lean?: number; eager?: boolean }) {
  const w = Math.round((h * 163) / 450);
  return (
    <div className={`${s.rk} ${className ?? ""}`} style={{ width: w, "--h": `${h}px`, "--lean": `${lean}deg` } as CSSProperties} aria-hidden>
      <div className={s.plume}><i /><i /><i /></div>
      <picture>
        <source type="image/avif" srcSet={ROCKET.avif} sizes={`${w}px`} />
        {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized AVIF/WebP plates, <picture> needs a plain <img> */}
        <img src={ROCKET.fallback} srcSet={ROCKET.webp} sizes={`${w}px`} alt="" width={w} height={h} loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "low" : undefined} decoding="async" />
      </picture>
    </div>
  );
}

/** Hero sky: blur-up LQIP (CSS background on .hiw-sky) under a per-breakpoint <picture>; the LCP element on every viewport. */
function HeroSky() {
  return (
    <picture>
      <source media={MQ_MOBILE} type="image/avif" srcSet={HERO_SKY.mobileAvif} sizes={SIZES_MOBILE} />
      <source media={MQ_MOBILE} type="image/webp" srcSet={HERO_SKY.mobileWebp} sizes={SIZES_MOBILE} />
      <source type="image/avif" srcSet={HERO_SKY.desktopAvif} sizes={SIZES_DESKTOP} />
      {/* eslint-disable-next-line @next/next/no-img-element -- art-directed <picture> with its own preloads (see page head) */}
      <img src={HERO_SKY.fallback} srcSet={HERO_SKY.desktopWebp} sizes={SIZES_DESKTOP} alt="" width={1280} height={720} className="hiw-skyimg" fetchPriority="high" />
    </picture>
  );
}

/** Preload only the LCP plate, once per breakpoint (media) and only as AVIF (type): browsers without AVIF skip it and
 * fall back to the <picture> WebP source. Next 14 / React 18 can't hoist a media-scoped preload into <head> (ReactDOM.preload
 * has no `media`), so these sit at the top of <main> (preload is body-ok) where the preload scanner sees them first. */
function HeroPreload() {
  return (
    <>
      <link rel="preload" as="image" type="image/avif" media={MQ_MOBILE} imageSrcSet={HERO_SKY.mobileAvif} imageSizes={SIZES_MOBILE} fetchPriority="high" />
      <link rel="preload" as="image" type="image/avif" media={MQ_DESKTOP} imageSrcSet={HERO_SKY.desktopAvif} imageSizes={SIZES_DESKTOP} fetchPriority="high" />
    </>
  );
}

function Coin({ letter, tone, size = 56, children }: { letter: string; tone: "silver" | "gold"; size?: number; children?: ReactNode }) {
  return (
    <span className={s.coinWrap}>
      <span className={`${s.coin} ${tone === "gold" ? s.coinGold : s.coinSilver}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>{letter}</span>
      {children}
    </span>
  );
}

/** `plain` renders bare <a>s (the hero: no client component above the fold); elsewhere next/link keeps soft navigation. */
const CTAs = ({ primary, secondary, plain = false }: { primary: string; secondary: string; plain?: boolean }) => {
  const A = plain ? "a" : Link;
  return (
    <div className={s.ctas}>
      <A href={HIW_ROUTES.launch} className={`${s.btn} ${s.pri}`}><Icon name="plus" size={18} />{primary}</A>
      <A href={HIW_ROUTES.explore} className={s.btn}>{secondary}<Icon name="chevron-right" size={16} /></A>
    </div>
  );
};

export default function HowItWorksPage() {
  const [h1a, h1b] = HIW_HERO.h1.split(/(?<=\.) /);
  const D = HIW_PAIR.diagram;
  const F = HIW_GAME.flight;
  return (
    <main className={`${s.page} ${geistMono.variable}`}>
      {/* Hero (no step strip) */}
      <HeroPreload />
      <style dangerouslySetInnerHTML={{ __html: HERO_CSS }} />
      <header className="hiw-hero">
        <div className="hiw-sky" aria-hidden>
          <HeroSky />
          <div className="hiw-shade" />
          <Rocket h={190} className="hiw-rocket" eager />
        </div>
        <div className="hiw-copy">
          <p className={`${s.eyebrow} ${s.center} hiw-eyebrow`}>{HIW_HERO.eyebrow}</p>
          <h1 className="hiw-h1"><span className="hiw-hl">{h1a}</span> <span className="hiw-hl">{h1b}</span></h1>
          <p className="hiw-sub">{HIW_HERO.sub}</p>
          <CTAs {...HIW_HERO.ctas} plain />
        </div>
      </header>

      <SubNav />

      {/* 01 · How a pair works */}
      <section className={s.sec} id="pair" aria-labelledby="pair-h">
        <div className={s.wrap}>
          <div className={s.two}>
            <div><Head n={HIW_PAIR.n} eyebrow={HIW_PAIR.eyebrow} h2={HIW_PAIR.h2} id="pair-h" /></div>
            <div>{HIW_PAIR.body.map((b) => <p key={b} className={s.lead}>{b}</p>)}</div>
          </div>
          <figure className={`${s.card} ${s.diag}`}>
            <div className={s.flow}>
              <div className={s.node}>
                <Coin letter={D.base.coin} tone="silver" />
                <div className={s.nt}>{D.base.title}</div><div className={s.nv}>{D.base.value}</div><div className={s.nd}>{D.base.desc}</div>
              </div>
              <div className={s.arrow}>{D.arrows[0]}<i aria-hidden /></div>
              <div className={`${s.node} ${s.nodeRocket}`}>
                <Coin letter={D.rocket.coin} tone="gold"><span className={s.coinBadge} aria-hidden>{D.rocket.baseCoin}</span></Coin>
                <div className={s.nt}>{D.rocket.title}</div><div className={s.nv}>{D.rocket.value}</div><div className={s.nd}>{D.rocket.desc}</div>
              </div>
              <div className={s.arrow}>{D.arrows[1]}<i aria-hidden /></div>
              <div className={`${s.node} ${s.nodeLp}`}>
                <span className={s.lockRing} aria-hidden><Icon name="locked-liquidity" size={26} /></span>
                <div className={s.nt}>{D.lp.title}</div><div className={s.nv}>{D.lp.value}</div><div className={s.nd}>{D.lp.desc}</div>
              </div>
            </div>
            <figcaption className={s.diagFoot}>
              {D.foot.map((f) => <span key={f.strong}><Icon name={f.icon} size={14} /> <b>{f.strong}</b>{f.text}</span>)}
              <span className={s.sp} />
              <span className={s.sample}>{D.sample}</span>
            </figcaption>
          </figure>
          <Items items={HIW_PAIR.items} />
        </div>
      </section>

      {/* 02 · How the game works */}
      <section className={s.sec} id="game" aria-labelledby="game-h">
        <div className={s.wrap}>
          <div className={`${s.two} ${s.twoCenter}`}>
            <div>
              <Head n={HIW_GAME.n} eyebrow={HIW_GAME.eyebrow} h2={HIW_GAME.h2} id="game-h" />
              <TradeLegend size="lg" className={s.gameLegend} />
              {HIW_GAME.body.map((b, i) => <p key={b} className={`${s.lead}${i === 0 ? " " + s.leadFirst : ""}`}>{b}</p>)}
            </div>
            <div className={s.flight} role="img" aria-label={F.alt}>
              <Image src={withBase(SKY.flight)} alt="" fill loading="lazy" sizes="(max-width: 760px) 100vw, 480px" quality={65} className={s.skyImg} />
              <div className={s.flightShade} />
              <Rocket h={190} lean={3} className={s.flightRocket} />
              <div className={s.hud}><div className={s.hudK}>{F.hudLabel}</div><div className={s.hudV}>{F.hudValue}</div><div className={s.hudD}>{F.hudDelta}</div></div>
              <span className={`${s.floater} ${s.f1}`}>{F.floaters[0]}</span>
              <span className={`${s.floater} ${s.f2}`}>{F.floaters[1]}</span>
              <span className={`${s.floater} ${s.fBomb}`}><Icon name="bomb-nuke" size={13} /> {F.bomb}</span>
              <div className={s.flightBar}>
                <span className={s.pill}><Icon name="crew" size={14} />&nbsp;{F.aboard}</span>
                <span className={s.sp} />
                <span className={`${s.fbtn} ${s.fBoost}`}><Icon name="boost" size={16} />{F.boost}</span>
                <span className={`${s.fbtn} ${s.fDump}`}><Icon name="dump" size={16} />{F.dump}</span>
              </div>
              <span className={s.flightSample}>{F.sample}</span>
            </div>
          </div>
          <p className={`${s.eyebrow} ${s.capt}`} id="bombs-cap">{HIW_GAME.caption}</p>
          <ul className={s.bombs} aria-labelledby="bombs-cap">
            {HIW_GAME.tiers.map((t, i) => (
              <li key={t.id} className={s.bomb} style={{ "--c": `var(--dsc-bomb-${t.id}-color)` } as CSSProperties}>
                <Icon name={`bomb-${t.id}`} size={28} style={{ color: "var(--c)" }} />
                <div className={s.bn}>{t.name}</div>
                <div className={s.br}>{t.range}</div>
                <div className={s.bk}>{HIW_GAME.tierUnit}</div>
                <div className={s.meter}><OrbMeter tier={(i + 1) as BombTier} label="" /></div>
              </li>
            ))}
          </ul>
          <Items items={HIW_GAME.items} />
          <p className={s.note}>{HIW_GAME.note}</p>
        </div>
      </section>

      {/* 03 · Bonding curve vs Uniswap */}
      <section className={s.sec} id="phases" aria-labelledby="phases-h">
        <div className={s.wrap}>
          <div className={s.two}>
            <div><Head n={HIW_PHASES.n} eyebrow={HIW_PHASES.eyebrow} h2={HIW_PHASES.h2} id="phases-h" /></div>
            <div>{HIW_PHASES.body.map((b) => <p key={b} className={s.lead}>{b}</p>)}</div>
          </div>
          <div className={s.phases}>
            <div className={`${s.card} ${s.ph}`}>
              <div className={s.phTop}><span className={s.phK}>{HIW_PHASES.p1.k}</span><span className={s.sp} /><Icon name="chart" size={22} /></div>
              <h3>{HIW_PHASES.p1.title}</h3><p>{HIW_PHASES.p1.body}</p>
            </div>
            <div className={s.gradlink} aria-hidden><span className={s.gradO}><Icon name="graduation" size={22} /></span>{HIW_PHASES.link}</div>
            <div className={`${s.card} ${s.ph} ${s.ph2}`}>
              <div className={s.phTop}><span className={s.phK}>{HIW_PHASES.p2.k}</span><span className={s.sp} /><Icon name="locked-liquidity" size={22} /></div>
              <h3>{HIW_PHASES.p2.title}</h3><p>{HIW_PHASES.p2.body}</p>
            </div>
          </div>
          <div className={`${s.card} ${s.chart}`}>
            <LazyCurveChart minHeight="var(--chart-h)" className={s.chartDesk} />
            <LazyCurveChart minHeight="var(--chart-h)" className={s.chartMob} compact />
          </div>
          <div className={s.tableWrap}>
            <table className={s.cmp}>
              <thead>
                <tr><td /><th scope="col">{HIW_PHASES.p1.k} · {HIW_PHASES.p1.title}</th><th scope="col">{HIW_PHASES.p2.k} · {HIW_PHASES.p2.title}</th></tr>
              </thead>
              <tbody>
                {HIW_PHASES.rows.map(([k, a, b]) => <tr key={k}><th scope="row">{k}</th><td>{a}</td><td>{b}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className={s.grad}><Icon name="graduation" size={15} /> {HIW_PHASES.grad}</p>
          <p className={s.after}>{HIW_PHASES.after}</p>
        </div>
      </section>

      {/* 04 · Game difficulties (Simulator only, C12) */}
      <section className={s.sec} id="modes" aria-labelledby="modes-h">
        <div className={s.wrap}>
          <div className={s.two}>
            <div><Head n={HIW_MODES.n} eyebrow={HIW_MODES.eyebrow} h2={HIW_MODES.h2} id="modes-h" /></div>
            <div>{HIW_MODES.body.map((b) => <p key={b} className={s.lead}>{b}</p>)}</div>
          </div>
          <ul className={s.modes}>
            {HIW_MODES.cards.map((c) => (
              <li key={c.id} className={`${s.card} ${s.mode}`} style={{ "--c": c.tone === "up" ? "var(--dsc-up)" : c.tone === "secondary" ? "var(--dsc-secondary)" : "#FF7AAE" } as CSSProperties}>
                <h3 className={s.lab}><Link href={HIW_ROUTES.simDifficulty(c.id)} className={s.modeLink}>{c.title}</Link></h3>
                <div className={s.tag}>{c.tag}</div>
                <LazySpark minHeight={80} id={c.id} />
                <p>{c.body}</p>
                <div className={s.bots}>{HIW_MODES.botsLabel} · {c.bots}</div>
              </li>
            ))}
          </ul>
          <div className={s.mnote}>
            <span className={s.mnoteTxt}>{HIW_MODES.note}</span>
            <span className={s.sp} />
            <span className={s.illus}>{HIW_MODES.chartsNote}</span>
            <Link href={HIW_ROUTES.sim} className={`${s.btn} ${s.btnSm}`}>{HIW_MODES.cta}<Icon name="chevron-right" size={15} /></Link>
          </div>
        </div>
      </section>

      {/* 05 · Fees & creator rewards */}
      <section className={s.sec} id="fees" aria-labelledby="fees-h">
        <div className={s.wrap}>
          <div className={s.two}>
            <div><Head n={HIW_FEES.n} eyebrow={HIW_FEES.eyebrow} h2={HIW_FEES.h2} id="fees-h" /></div>
            <div>{HIW_FEES.body.map((b) => <p key={b} className={s.lead}>{b}</p>)}</div>
          </div>
          <p className={s.feeHead}><span className={s.feeBig}>{HIW_FEES.headline.value}</span><span>{HIW_FEES.headline.label}</span></p>
          <div className={s.split} aria-hidden>
            {HIW_FEES.split.map((x) => (
              <div key={x.name} style={{ flex: parseFloat(x.pct), background: x.color, color: x.color === "#44426A" ? "#E8EAEE" : undefined, padding: x.pct === "1%" ? 0 : undefined }}>{x.pct === "1%" ? "" : x.pct}</div>
            ))}
          </div>
          <ul className={s.legend}>
            {HIW_FEES.split.map((x) => (
              <li key={x.name} style={{ "--c": x.color } as CSSProperties}><b>{x.name} <span>{x.pct}</span></b><p>{x.desc}</p></li>
            ))}
          </ul>
          <p className={s.example}>{HIW_FEES.example}</p>
          <div className={s.fcards}>
            {HIW_FEES.cards.map((c) => (
              <div key={c.title} className={`${s.card} ${s.fcard}`}>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
                {c.title === "Anti-snipe" && <LazySnipeChart minHeight={90} />}
                <p>{c.more}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 06 · FAQ */}
      <section className={s.sec} id="faq" aria-labelledby="faq-h">
        <div className={s.wrap}>
          <Head n={HIW_FAQ.n} eyebrow={HIW_FAQ.eyebrow} h2={HIW_FAQ.h2} id="faq-h" />
          <Faq />
        </div>
      </section>

      {/* Final CTA */}
      <section className={s.final} aria-labelledby="final-h">
        <Image src={withBase(SKY.final)} alt="" fill loading="lazy" sizes="(max-width: 760px) 100vw, calc(100vw - 270px)" quality={65} className={s.skyImg} style={{ objectPosition: "50% 30%" }} />
        <div className={s.finalShade} aria-hidden />
        <div className={s.finalC}>
          <h2 id="final-h">{HIW_FINAL.h2}</h2>
          <p className={s.finalSub}>{HIW_FINAL.sub}</p>
          <CTAs {...HIW_FINAL.ctas} />
          <p className={s.docs}>{HIW_FINAL.link}</p>
        </div>
      </section>
      <footer className={s.footer}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG lockup, no optimisation needed */}
        <img src={withBase("/brand/disciple-lockup-horizontal-light.svg")} alt={HIW_FINAL.logoAlt} width={120} height={31} className={s.lockup} loading="lazy" />
        <span className={s.sp} />
        <span>{HIW_FINAL.footer}</span>
        <Link href="/security" className={s.footLink}>Security</Link>
      </footer>
    </main>
  );
}
