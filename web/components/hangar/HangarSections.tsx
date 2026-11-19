"use client";
/**
 * Hangar sections under the bay (canvas board "Hangar (pilot profile)"): the service record strip, Your fleet (the
 * rockets this pilot is aboard, as the lobby's Live window cards with their seat's worth) and the trophy case. All
 * live: wallet reads, the lobby's rockets and /api/achievements. Nothing here is sample data.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { V1_RULES, achievementIconPath, rarityStyle } from "@/lib/achievements";
import { rarityRank } from "@/lib/config";
import { MILESTONE_COPY } from "@/lib/xp";
import type { HomeCoin } from "@/lib/home/trending";
import LiveCard from "@/components/home/LiveCard";
import type { LiveHolding, LivePortfolio } from "@/components/profile/LiveHoldings";
import { signedUsd2, usd2 } from "@/components/profile/money";
import { DEPOSIT_HREF, onDepositClick, openCash } from "@/lib/cashLink";
import Tooltip from "@/components/ui/Tooltip";
import { onTurboCash } from "@/lib/turbo/turboCash";

/** Service record strip (maker 2026-11-18): Hangar value, Cash, Turbo cash. Flights aboard / Rockets launched are gone
 *  (Your fleet below already shows them). Turbo cash is the owner's own trading balance, so only the private Hangar has it. */
export function ServiceRecord({ pf, isPrivate }: { pf: LivePortfolio | null; isPrivate: boolean }) {
  const [turbo, setTurbo] = useState(0);
  const [canAdd, setCanAdd] = useState(false);
  useEffect(() => (isPrivate ? onTurboCash((t) => { setTurbo(t.usd); setCanAdd(t.canAdd); }) : undefined), [isPrivate]);
  const ok = pf && pf.ok;
  const rockets = ok ? pf.rows.reduce((s, r) => s + r.usd, 0) : null;
  const total = ok ? pf.cashUsd + rockets! + (isPrivate ? turbo : 0) : null;
  const today = ok && pf.rows.every((r) => Number.isFinite(r.price24h)) ? pf.rows.reduce((s, r) => s + r.tokens * (r.priceNow - r.price24h), 0) : null;
  return (
    <section className={`hg-record${isPrivate ? " three" : ""}`} aria-label="Service record" data-testid="profile-portfolio">
      <div>
        <span className="l">Hangar value</span>
        <b data-testid="portfolio-total">{total != null ? usd2(total) : "—"}</b>
        {today != null && <span className={Math.abs(today) < 0.005 ? "s" : today > 0 ? "s up" : "s down"}>{signedUsd2(today)} today</span>}
      </div>
      <div>
        <span className="l">Cash</span>
        <b data-testid="portfolio-cash">{ok ? usd2(pf.cashUsd) : "—"}</b>
        {isPrivate ? <Link href={DEPOSIT_HREF} onClick={onDepositClick} className="s">Add cash</Link> : <span className="s" />}
      </div>
      {isPrivate && (
        <div>
          <span className="l">Turbo cash</span>
          <b data-testid="portfolio-turbo">{usd2(turbo)}</b>
          {canAdd ? <a href={DEPOSIT_HREF} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); openCash("turbo"); }} className="s">Add to Turbo</a> : <span className="s" />}
        </div>
      )}
    </section>
  );
}

/** A holding as a lobby card. A rocket the lobby doesn't list yet still gets a card from what the wallet knows. */
function asCoin(h: LiveHolding, home: Map<string, HomeCoin> | null): HomeCoin {
  const hit = home?.get(h.coin.toLowerCase());
  if (hit) return hit;
  return { token: h.coin, name: h.name || h.symbol || "Rocket", ticker: h.symbol ? `$${h.symbol}` : "", mcapUsd: 0, graduated: false, block: 0, stats: null } as unknown as HomeCoin;
}

export function Fleet({ rows, home, launched, isPrivate, owner }: {
  rows: LiveHolding[] | null; home: Map<string, HomeCoin> | null; launched: HomeCoin[] | null; isPrivate: boolean; owner: string;
}) {
  const [tab, setTab] = useState<"aboard" | "launched">("aboard");
  const list = tab === "aboard" ? rows : launched;
  return (
    <section className="hg-sec" aria-labelledby="hg-fleet">
      <header className="hg-sech">
        <div><h2 id="hg-fleet" className="dsc3-h2">{isPrivate ? "Your fleet" : "Fleet"}</h2></div>
        <div className="hg-chips" role="group" aria-label="Fleet">
          <button type="button" className="dsc3-chip" aria-pressed={tab === "aboard"} onClick={() => setTab("aboard")}>Aboard</button>
          <button type="button" className="dsc3-chip" aria-pressed={tab === "launched"} onClick={() => setTab("launched")}>Launched</button>
        </div>
      </header>
      {/* still reading the wallet: card-shaped pulses, not one flat grey box (maker 2026-11-19) */}
      {list == null ? <div className="hg-fleet" aria-busy="true" data-testid="tab-rockets"><i className="hg-fleet-sk" /><i className="hg-fleet-sk" /></div> : !list.length ? (
        <div className="hg-empty" data-testid="tab-rockets">
          {tab === "aboard"
            ? isPrivate ? <><b>No seats yet</b><Link href="/" className="dsc3-btn dsc3-btn-white">Find a flight</Link></> : <p>{owner} isn&apos;t aboard any rockets right now.</p>
            : isPrivate ? <><b>Nothing launched yet</b><Link href="/create" className="dsc3-btn dsc3-btn-white">Start a launch</Link></> : <p>{owner} hasn&apos;t launched a rocket yet.</p>}
        </div>
      ) : (
        <div className="hg-fleet" data-testid="tab-rockets">
          {tab === "aboard"
            ? (list as LiveHolding[]).map((h) => <LiveCard key={h.coin} c={asCoin(h, home)} seat={usd2(h.usd)} testId="fleet-card" />)
            : (list as HomeCoin[]).map((c) => <LiveCard key={c.token} c={c} testId="fleet-card" />)}
        </div>
      )}
    </section>
  );
}

export function TrophyCase({ got, href = "/achievements" }: { got: Map<string, number> | null; href?: string }) {
  const shown = useMemo(() => [...V1_RULES]
    .sort((a, b) => Number(!!got?.has(b.id)) - Number(!!got?.has(a.id)) || rarityRank(a.rarity) - rarityRank(b.rarity)).slice(0, 6), [got]);
  const n = got ? V1_RULES.filter((r) => got.has(r.id)).length : null;
  return (
    <section className="dsc3-panel hg-panel" aria-labelledby="hg-trophies">
      <header className="hg-panelh"><h2 id="hg-trophies">Trophy case</h2><Link href={href}>All trophies</Link></header>
      <p className="hg-sub">{n == null ? " " : `${n} of ${V1_RULES.length} earned`}</p>
      <ul className="hg-trophies">
        {shown.map((m) => {
          const r = rarityStyle(m.rarity);
          const on = !!got?.has(m.id);
          const name = MILESTONE_COPY[m.id]?.name ?? m.name;
          // hover (desktop) or tap (phone): what the trophy is for, earned or locked (maker 2026-11-17)
          return (
            <Tooltip key={m.id} content={<><strong>{name} · {on ? r.label : "Locked"}</strong>{MILESTONE_COPY[m.id]?.desc}</>}>
            <li className={on ? "on" : ""} style={{ ["--rar" as string]: r.border, ["--rar-glow" as string]: r.glow }} aria-label={`${name}${on ? "" : ", locked"}`}>
              <span className="gem" aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={achievementIconPath(m.id)} alt="" width={44} height={44} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
              </span>
              <span className="nm">{name}</span>
            </li>
            </Tooltip>
          );
        })}
      </ul>
    </section>
  );
}
