"use client";
/**
 * MOCKUP (maker 2026-11-19, not wired): the private Rewards panel that replaces RewardsPopup and the banner's Rewards
 * button. Opened from the fourth Hangar balance tile. Rewards from hosting, crew, KOL and treasury drops in one claim;
 * where claims pay (own wallet, another wallet or a Disciple @user); per hosted coin: edit image / description / links
 * (name + ticker locked, Launchpad.updateMetadata) and transfer creator (Launchpad.transferCreator, AnonLauncher BySig).
 * Presentational only: every number comes from props. Rendered on /dev/creator-panel for the sign-off screenshots.
 */
import { useState } from "react";
import Sheet from "@/components/profile/Sheet";
import Icon from "@/components/icons/Icon";
import PairArt from "@/components/pairart/PairArt";
import { moneyParts, usd2 } from "@/components/profile/money";
import { withBase } from "@/lib/base-path";

export type PanelRocket = { token: string; name: string; ticker: string; img: string; kind: "host" | "crew"; usd: number; ready: number; anon?: boolean;
  desc?: string; links?: { x?: string; tg?: string; web?: string } };
export type PanelData = {
  ready: number; allTime: number; week: number;
  byKind: { host: number; crew: number; kol: number; drops: number };
  nHost: number; nCrew: number; nKol: number; nDrops: number;
  payTo: { kind: "me" | "user" | "wallet"; label: string; addr: string };
  rockets: PanelRocket[];
  history: { k: "Hosting" | "Crew" | "KOL" | "Drop"; day: string; usd: number; note?: string }[];
  invite: string;
};
export type PanelView = "home" | "history" | "payto" | "coin" | "transfer";

function Big({ v }: { v: number }) {
  const { whole, cents } = moneyParts(v);
  return <span className={`p5-amt ${v < 0.005 ? "zero" : ""}`}><span className="s">$</span><span className="w">{whole}</span><span className="c">.{cents}</span></span>;
}

function Head({ title, onBack, onClose, right }: { title: React.ReactNode; onBack?: () => void; onClose: () => void; right?: React.ReactNode }) {
  return (
    <header className="p5-mhead">
      {onBack
        ? <button type="button" className="p5-icon" aria-label="Back" onClick={onBack}><Icon name="chevron-left" size={20} /></button>
        : <button type="button" className="p5-icon p5-phone" aria-label="Back" onClick={onClose}><Icon name="chevron-left" size={20} /></button>}
      <h2>{title}</h2>
      <div className="p5-mhead-acts">
        {right}
        <button type="button" className="p5-icon p5-desk" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
    </header>
  );
}

function PayTo({ d, onChange }: { d: PanelData; onChange: () => void }) {
  return (
    <button type="button" className="cp-payto" onClick={onChange} data-testid="cp-payto">
      <span className="k">Pays to</span>
      <span className="who">{d.payTo.kind === "me" ? <Icon name="wallet" size={16} /> : <Icon name="profile" size={16} />}<b>{d.payTo.label}</b><em>{d.payTo.addr}</em></span>
      <span className="go">Change<Icon name="chevron-right" size={16} /></span>
    </button>
  );
}

export default function CreatorPanel({ open = true, onClose = () => {}, d, view: v0 = "home", coin: c0 }: {
  open?: boolean; onClose?: () => void; d: PanelData; view?: PanelView; coin?: string;
}) {
  const [view, setView] = useState<PanelView>(v0);
  const [coin, setCoin] = useState<string | undefined>(c0 ?? d.rockets.find((r) => r.kind === "host")?.token);
  const c = d.rockets.find((r) => r.token === coin);
  const tiles = [
    { k: "Hosting", usd: d.byKind.host, sub: `${d.nHost} rockets` },
    { k: "Crew", usd: d.byKind.crew, sub: `${d.nCrew} rockets` },
    { k: "KOL", usd: d.byKind.kol, sub: `${d.nKol} payouts` },
    { k: "Drops", usd: d.byKind.drops, sub: `${d.nDrops} from Disciple` },
  ];
  const tab = view === "history" ? "history" : "rockets";

  return (
    <Sheet open={open} onClose={onClose} label="Rewards" className={`p5-modal p5-rewards cp${view === "coin" || view === "transfer" ? " cp-coin" : ""}`} testId="creator-panel">
      {(view === "home" || view === "history") && <>
        <Head title="Rewards" onClose={onClose}
          right={<button type="button" className="p5-btn sm" aria-label="Share"><Icon name="share" size={16} /> <span className="p5-desk">Share</span></button>} />
        <div className="p5-rw-claim">
          <div className="tx">
            <span className="k">Ready to claim</span>
            <Big v={d.ready} />
            <span className="sub">{usd2(d.allTime)} earned all time · <b className="up">+{usd2(d.week)} this week</b></span>
          </div>
          <button type="button" className="p5-rw-go" disabled={d.ready < 0.005}>Claim</button>
        </div>
        <PayTo d={d} onChange={() => setView("payto")} />
        <div className="p5-rw-tiles cp-tiles">
          {tiles.map((x) => <div key={x.k} className="p5-rw-tile"><span className="k">{x.k}</span><b>{usd2(x.usd)}</b><span>{x.sub}</span></div>)}
        </div>
        <div className="p5-tabs3" role="tablist" aria-label="Rewards">
          <button type="button" role="tab" aria-selected={tab === "rockets"} className={tab === "rockets" ? "on" : ""} onClick={() => setView("home")}>Rockets</button>
          <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setView("history")}>History</button>
        </div>
        {tab === "rockets" ? (
          <ul className="p5-plist cp-list">
            {d.rockets.map((x) => {
              const row = <>
                <PairArt src={withBase(x.img)} tk={x.ticker} size="list" px={40} />
                <span className="n"><b>{x.name}</b><span>${x.ticker}</span></span>
                {x.anon && <span className="p5-tag cp-anon"><Icon name="lock" size={11} /><span className="t"> Anon</span></span>}
                <span className="p5-tag">{x.kind === "host" ? "Host" : "Crew"}</span>
                <span className="v up">+{usd2(x.ready)}</span>
              </>;
              return x.kind === "host"
                ? <li key={x.token}><button type="button" className="p5-prow cp-prow" onClick={() => { setCoin(x.token); setView("coin"); }} aria-label={`Manage ${x.name}`}>{row}<Icon name="chevron-right" size={18} className="cp-chev" /></button></li>
                : <li key={x.token} className="p5-prow cp-prow">{row}<span className="cp-chev sp" /></li>;
            })}
          </ul>
        ) : (
          <ul className="p5-hist cp-hist">
            {d.history.map((h, i) => (
              <li key={i}><span className="n"><b>{h.k}{h.note && <em> · {h.note}</em>}</b><span>{h.day}</span></span><span className="v up">+{usd2(h.usd)}</span></li>
            ))}
          </ul>
        )}
        <div className="p5-rw-invite">
          <span className="lab">Your invite link</span>
          <div className="p5-ref"><span className="u">{d.invite}</span><button type="button" className="p5-btn sm"><Icon name="copy" size={16} /> Copy</button></div>
        </div>
      </>}

      {view === "payto" && <>
        <Head title="Pays to" onBack={() => setView("home")} onClose={onClose} />
        <div className="cp-opts" role="radiogroup" aria-label="Pays to">
          <button type="button" role="radio" aria-checked={false} className="cp-opt">
            <span className="dot" /><span className="t"><b>Your wallet</b><span className="mono">0x9f2c…41De</span></span>
          </button>
          <button type="button" role="radio" aria-checked className="cp-opt on">
            <span className="dot" /><span className="t"><b>Someone else</b></span>
          </button>
        </div>
        <label className="p5-fld">
          <span className="lab">Wallet or @username</span>
          <input className="p5-inp" defaultValue="@moonboi" />
        </label>
        <div className="cp-who">
          <span className="av" style={{ backgroundImage: `url(${withBase("/pairs/coin/shroom.webp")})` }} />
          <span className="t"><b>@moonboi</b><span className="mono">0x51Ab…9C07</span></span>
          <Icon name="check" size={18} className="ok" />
        </div>
        <div className="cp-warn" role="note"><Icon name="warning" size={16} /><span>Claims from all your rockets go here. Sent rewards can&apos;t be pulled back.</span></div>
        <span className="cx-fine left cp-fee">Network fee ~$0.01 · 3 rockets</span>
        <button type="button" className="p5-btn primary wide p5-gold">Save</button>
      </>}

      {view === "coin" && c && <>
        <Head title={<span className="cp-ct"><PairArt src={withBase(c.img)} tk={c.ticker} size="list" px={32} />{c.name}</span>} onBack={() => setView("home")} onClose={onClose}
          right={<a className="p5-btn sm" href="#"><span className="p5-desk">Coin page</span><Icon name="external-link" size={14} /></a>} />
        <div className="p5-rw-claim cp-mini">
          <div className="tx"><span className="k">Ready to claim</span><b className="cp-v">{usd2(c.ready)}</b><span className="sub">{usd2(c.usd)} earned all time</span></div>
          <button type="button" className="p5-rw-go">Claim</button>
        </div>
        <section className="cp-sec">
          <h3 className="cp-h">Coin info</h3>
          <div className="cp-img">
            <PairArt src={withBase(c.img)} tk={c.ticker} size="list" px={64} />
            <button type="button" className="p5-btn sm"><Icon name="refresh" size={14} /> Change image</button>
          </div>
          <div className="cp-two">
            <div className="p5-fld"><span className="lab">Name</span><span className="p5-inp cp-locked">{c.name}<Icon name="lock" size={14} /></span></div>
            <div className="p5-fld"><span className="lab">Ticker</span><span className="p5-inp cp-locked">${c.ticker}<Icon name="lock" size={14} /></span></div>
          </div>
          <label className="p5-fld"><span className="lab">Description</span><textarea className="p5-inp ta" rows={3} defaultValue={c.desc} /></label>
          <div className="p5-fld"><span className="lab">Links</span>
            <div className="cp-links">
              <span className="p5-inp cp-li"><b>X</b><input defaultValue={c.links?.x} placeholder="x.com/…" /></span>
              <span className="p5-inp cp-li"><b>TG</b><input defaultValue={c.links?.tg} placeholder="t.me/…" /></span>
              <span className="p5-inp cp-li"><b>Web</b><input defaultValue={c.links?.web} placeholder="https://" /></span>
            </div>
          </div>
          <button type="button" className="p5-btn primary wide">Save info</button>
        </section>
        <section className="cp-sec">
          <h3 className="cp-h">Creator</h3>
          <button type="button" className="cp-row" onClick={() => setView("transfer")}><Icon name="key" size={16} /><b>Transfer creator</b><Icon name="chevron-right" size={18} /></button>
        </section>
      </>}

      {view === "transfer" && c && <>
        <Head title="Transfer creator" onBack={() => setView("coin")} onClose={onClose} />
        <div className="cp-who cp-coinrow"><PairArt src={withBase(c.img)} tk={c.ticker} size="list" px={40} /><span className="t"><b>{c.name}</b><span>${c.ticker}</span></span></div>
        <label className="p5-fld">
          <span className="lab">New creator</span>
          <input className="p5-inp" defaultValue="@lunadev" />
        </label>
        <div className="cp-who">
          <span className="av" style={{ backgroundImage: `url(${withBase("/pairs/coin/orbio.webp")})` }} />
          <span className="t"><b>@lunadev</b><span className="mono">0xC3e0…77a2</span></span>
          <Icon name="check" size={18} className="ok" />
        </div>
        <div className="cp-warn bad" role="note"><Icon name="warning" size={16} /><span>Unclaimed and future fees, coin info and creator rights move to @lunadev. You can&apos;t undo this.</span></div>
        <span className="cx-fine left cp-fee">{usd2(c.ready)} unclaimed goes with it · Network fee ~$0.01</span>
        <button type="button" className="p5-btn wide cp-danger">Hold to transfer</button>
      </>}
    </Sheet>
  );
}
