"use client";
/**
 * Hangar sections under the bay (canvas board "Hangar (pilot profile)"): the service record strip, Your fleet (the
 * rockets this pilot is aboard, as the lobby's Live window cards with their seat's worth) and the trophy case. All
 * live: wallet reads, the lobby's rockets and /api/achievements. Nothing here is sample data.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { V1_RULES, achievementIconPath, rarityStyle } from "@/lib/achievements";
import { rarityRank } from "@/lib/config";
import { MILESTONE_COPY } from "@/lib/xp";
import type { HomeCoin } from "@/lib/home/trending";
import LiveCard from "@/components/home/LiveCard";
import type { LiveHolding, LivePortfolio } from "@/components/profile/LiveHoldings";
import { signedUsd2, usd2 } from "@/components/profile/money";
import { DEPOSIT_HREF, onDepositClick } from "@/lib/cashLink";

export function ServiceRecord({ pf, aboard, launched, isPrivate }: { pf: LivePortfolio | null; aboard: number | null; launched: HomeCoin[] | null; isPrivate: boolean }) {
  const ok = pf && pf.ok;
  const rockets = ok ? pf.rows.reduce((s, r) => s + r.usd, 0) : null;
  const total = ok ? pf.cashUsd + rockets! : null;
  const today = ok ? pf.rows.reduce((s, r) => s + r.tokens * (r.priceNow - r.price24h), 0) : null;
  const best = launched?.length ? launched.reduce((a, b) => (b.mcapUsd > a.mcapUsd ? b : a)) : null;
  return (
    <section className="hg-record" aria-label="Service record" data-testid="profile-portfolio">
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
      <div>
        <span className="l">Flights aboard</span>
        <b data-testid="portfolio-rockets-count">{aboard ?? "—"}</b>
        <span className="s" data-testid="portfolio-rockets">{rockets != null ? `${usd2(rockets)} in seats` : ""}</span>
      </div>
      <div>
        <span className="l">Rockets launched</span>
        <b>{launched ? launched.length : "—"}</b>
        <span className="s">{best ? `Best: ${best.name}` : ""}</span>
      </div>
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
        <div><h2 id="hg-fleet" className="dsc3-h2">{isPrivate ? "Your fleet" : "Fleet"}</h2><span>{tab === "aboard" ? (isPrivate ? "Rockets you're aboard" : `Rockets ${owner} is aboard`) : (isPrivate ? "Rockets you launched" : `Rockets ${owner} launched`)}</span></div>
        <div className="hg-chips" role="group" aria-label="Fleet">
          <button type="button" className="dsc3-chip" aria-pressed={tab === "aboard"} onClick={() => setTab("aboard")}>Aboard</button>
          <button type="button" className="dsc3-chip" aria-pressed={tab === "launched"} onClick={() => setTab("launched")}>Launched</button>
        </div>
      </header>
      {list == null ? <div className="hg-fleet" aria-busy="true" data-testid="tab-rockets" /> : !list.length ? (
        <div className="hg-empty" data-testid="tab-rockets">
          {tab === "aboard"
            ? isPrivate ? <><b>No seats yet</b><p>Drop into a live flight from the lobby and boost it. It shows up here.</p><Link href="/" className="dsc3-btn dsc3-btn-white">Find a flight</Link></> : <p>{owner} isn&apos;t aboard any rockets right now.</p>
            : isPrivate ? <><b>Nothing launched yet</b><p>Host a match: build a rocket and open the hatch.</p><Link href="/create" className="dsc3-btn dsc3-btn-white">Start a launch</Link></> : <p>{owner} hasn&apos;t launched a rocket yet.</p>}
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

export function TrophyCase({ got }: { got: Map<string, number> | null }) {
  const shown = useMemo(() => [...V1_RULES]
    .sort((a, b) => Number(!!got?.has(b.id)) - Number(!!got?.has(a.id)) || rarityRank(a.rarity) - rarityRank(b.rarity)).slice(0, 6), [got]);
  const n = got ? V1_RULES.filter((r) => got.has(r.id)).length : null;
  return (
    <section className="dsc3-panel hg-panel" aria-labelledby="hg-trophies">
      <header className="hg-panelh"><h2 id="hg-trophies">Trophy case</h2><Link href="/achievements">All trophies</Link></header>
      <p className="hg-sub">{n == null ? " " : `${n} of ${V1_RULES.length} earned`}</p>
      <ul className="hg-trophies">
        {shown.map((m) => {
          const r = rarityStyle(m.rarity);
          const on = !!got?.has(m.id);
          return (
            <li key={m.id} className={on ? "on" : ""} style={{ ["--rar" as string]: r.border, ["--rar-glow" as string]: r.glow }} title={MILESTONE_COPY[m.id]?.desc ?? ""}>
              <span className="gem" aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={achievementIconPath(m.id)} alt="" width={44} height={44} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
              </span>
              <span className="nm">{MILESTONE_COPY[m.id]?.name ?? m.name}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
