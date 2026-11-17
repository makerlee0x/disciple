"use client";
/**
 * Trophies (/achievements), built to the lobby canvas board "Trophies": the pilot card (level ring, XP bar, stats, next
 * unlock), today's and this week's missions side by side, the level rewards track (lib/collection REWARDS + prestige items), and the trophy
 * case of every milestone. Missions and XP come from /api/xp, milestones from /api/achievements (both scored by the cron).
 * Signed out, the missions still show (they're the same for everyone), with no progress.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { V1_RULES, achievementIconPath, rarityStyle } from "@/lib/achievements";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { rarityRank } from "@/lib/config";
import { displayName } from "@/lib/defaultUsername";
import { fetchUsernameStatus } from "@/lib/profile";
import { HULL_NAMES, PRESTIGE_HULL, REWARDS as COLLECTION_REWARDS, STARTER_SKIN, itemById, skinArt, skinId, trailArt, trailId } from "@/lib/collection";
import type { Progress } from "@/lib/unlocks";
import { MAX_LEVEL, MAX_PRESTIGE, PRESTIGE_NAMES, milestoneXp, missionById, MILESTONE_COPY, type MissionStatus } from "@/lib/xp";
import { blankXp, prestigeWithXp, untilLabel, usePilotWallet, useXp } from "@/lib/xpClient";
import s from "./trophies.module.css";

type Unlock = { id: string; unlockedAt?: number };
type Filter = "all" | "earned" | "locked";
const fmt = (n: number) => n.toLocaleString("en-US");

/** The rewards track (maker 2026-11-17, one collection for every mode): the collection items a level or a Prestige gives,
 *  in order. They land in Your rocket as copies that never trade. Trophy rewards are named in the head. */
type Rule = { kind: "free" } | { kind: "level"; level: number } | { kind: "prestige"; prestige: number };
type Reward = { id: string; kind: "skin" | "trail"; name: string; blurb: string; rule: Rule };
const BLURB: Record<string, string> = {
  [STARTER_SKIN]: "The rocket you start with.",
  [trailId("ice")]: "A cold blue wake everyone sees when you boost.",
  [skinId("needle", "walnut-brass")]: "Polished wood and brass on the Needle hull.",
  [skinId("bullet", "neon-circuit")]: "Glowing circuit lines on the Bullet.",
  [skinId(PRESTIGE_HULL, "white-gloss")]: "The Ring-tail hull, in every paint you've found.",
  [trailId("halo")]: "A gold ring wake for Prestige 2 pilots.",
};
const reward = (id: string, rule: Rule): Reward => {
  const it = itemById(id)!;
  const name = it.kind === "skin" ? (it.hull === PRESTIGE_HULL ? "Ring-tail hull" : `${HULL_NAMES[it.hull!]} | ${it.name}`) : `${it.name} trail`;
  return { id, kind: it.kind === "skin" ? "skin" : "trail", name, blurb: BLURB[id] ?? "", rule };
};
const REWARDS: Reward[] = [
  reward(STARTER_SKIN, { kind: "free" }),
  ...COLLECTION_REWARDS.filter((r) => r.rule.kind === "level").map((r) => reward(r.item, r.rule as Rule)),
  reward(skinId(PRESTIGE_HULL, "white-gloss"), { kind: "prestige", prestige: 1 }),
  reward(trailId("halo"), { kind: "prestige", prestige: 2 }),
];
const TROPHY_REWARDS = COLLECTION_REWARDS.filter((r) => r.rule.kind === "trophy").map((r) => itemById(r.item)?.name).filter(Boolean);
const isOpen = (r: Rule, p: Progress) => (r.kind === "free" ? true : r.kind === "level" ? p.prestige > 0 || p.level >= r.level : p.prestige >= r.prestige);

const whenLabel = (l: Reward) => (l.rule.kind === "prestige" ? `Prestige ${l.rule.prestige}` : `LV ${l.rule.kind === "level" ? l.rule.level : 1}`);
const lockLabel = (l: Reward) => (l.rule.kind === "prestige" ? `Prestige ${l.rule.prestige}` : l.rule.kind === "level" ? `Level ${l.rule.level}` : "");

function RewardArt({ r, height }: { r: Reward; height: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  if (r.kind === "skin") return <img src={withBase(skinArt(r.id))} alt="" style={{ height, width: "auto", objectFit: "contain" }} />;
  return <span className="hgu-plume" aria-hidden style={{ height, width: height / 3, backgroundImage: `url(${withBase(trailArt(r.id.replace(/^trail-/, "")))})` }} />;
}

function Mission({ m }: { m: MissionStatus }) {
  const pct = m.target ? Math.min(100, (m.progress / m.target) * 100) : 0;
  const usd = missionById(m.id)?.kind === "boost_usd";
  const u = usd ? "$" : "";
  return (
    <li className={`${s.mi}${m.done ? ` ${s.done}` : ""}`} data-testid={`mission-${m.id}`}>
      <div className={s.miTop}><span className={s.miT}>{m.title}</span><span className={s.xpc}>+{fmt(m.xp)} XP</span></div>
      <div className={s.miBar} role="progressbar" aria-valuemin={0} aria-valuemax={m.target} aria-valuenow={m.progress} aria-label={m.title}><i style={{ width: `${pct}%` }} /></div>
      <div className={s.miSub}>{m.done ? <b>Done</b> : `${u}${fmt(Math.floor(m.progress))} / ${u}${fmt(m.target)}`}</div>
    </li>
  );
}

export default function TrophiesPage() {
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const [unlocks, setUnlocks] = useState<Map<string, number>>(new Map());
  const [name, setName] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // server HTML can be older than the browser's clock (static/ISR): keep its "New in …" through hydration, then correct it
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!wallet || IS_STATIC_PREVIEW) { setUnlocks(new Map()); return; }
    let live = true;
    fetch(`/api/achievements?wallet=${wallet}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: Unlock[] } | null) => { if (live && j?.items) setUnlocks(new Map(j.items.filter((i) => i.unlockedAt).map((i) => [i.id, i.unlockedAt!]))); })
      .catch(() => {});
    return () => { live = false; };
  }, [wallet]);
  useEffect(() => {
    if (!wallet) { setName(null); return; }
    let live = true;
    setName(displayName(null, wallet));
    fetchUsernameStatus(wallet).then((r) => { if (live) setName(displayName(r.username, wallet)); }).catch(() => {});
    return () => { live = false; };
  }, [wallet]);

  const shown = xp ?? blankXp();
  const L = shown.level;
  const progress = useMemo<Progress | null>(() => (xp ? { level: xp.level.level, prestige: xp.level.prestige, trophies: new Set(unlocks.keys()) } : null), [xp, unlocks]);
  const open = (l: Reward) => (progress ? isOpen(l.rule, progress) : l.rule.kind === "free");
  const next = REWARDS.find((r) => !open(r)) ?? null;
  const unlockedCount = REWARDS.filter((r) => open(r)).length;

  const milestones = useMemo(() => [...V1_RULES].sort((a, b) => Number(unlocks.has(b.id)) - Number(unlocks.has(a.id)) || rarityRank(a.rarity) - rarityRank(b.rarity)), [unlocks]);
  const earned = milestones.filter((m) => unlocks.has(m.id)).length;
  const caseShown = milestones.filter((m) => filter === "all" || (filter === "earned") === unlocks.has(m.id));

  const nextLabel = (r: Reward) => {
    if (r.rule.kind === "level") return `${r.name} at level ${r.rule.level}`;
    if (r.rule.kind === "prestige") return `${r.name} at Prestige ${r.rule.prestige}`;
    return r.name;
  };
  const nextBadge = (r: Reward) => {
    if (r.rule.kind === "level" && L.prestige === 0) { const n = r.rule.level - L.level; return `Next · ${n} level${n === 1 ? "" : "s"}`; }
    return `Next · ${lockLabel(r)}`;
  };

  return (
    <div className={`${s.page} xp-trophies`} data-testid="trophies">
      <div className={s.head}>
        <div>
          <h1 className={s.h1}>Trophies</h1>
          <p className={s.lede}>Missions pay XP. Level up to unlock new paint for your rocket.</p>
        </div>
        {xp && <div className={s.total}>Total XP <b>{fmt(xp.totalXp)}</b></div>}
      </div>

      <div className={s.top}>
        <section className={`${s.card} ${s.pilot}`} aria-label="Your pilot level" data-testid="pilot-card">
          <div className={s.pilotSky} aria-hidden />
          <div className={s.pilotShade} aria-hidden />
          {xp ? (
            <>
              <div className={s.pilotId}>
                <Ring level={L.level} progress={L.progress} />
                <div className={s.pilotTx}>
                  <div className={s.eb}>{L.prestigeName} · Prestige {L.prestige}</div>
                  {name && <div className={s.pilotName}>{name}</div>}
                  <div className={s.meta}>{L.prestige >= MAX_PRESTIGE ? "Top prestige reached." : `Level ${MAX_LEVEL} lets you prestige to ${PRESTIGE_NAMES[L.prestige + 1]}.`}</div>
                </div>
              </div>
              <div className={s.pilotXp}>
                <div className={s.pilotXpRow}>
                  <span>{L.level >= MAX_LEVEL ? "Max level" : `${fmt(L.need - L.into)} XP to level ${L.level + 1}`}</span>
                  {L.need > 0 && <span className={s.mono}>{fmt(L.into)} / {fmt(L.need)}</span>}
                </div>
                <div className={s.xpBar} role="progressbar" aria-valuemin={0} aria-valuemax={L.need || 1} aria-valuenow={L.into} aria-label="Level progress"><i style={{ width: `${Math.round(L.progress * 100)}%` }} /></div>
              </div>
              <div className={s.stats}>
                <div><span>Trophies</span><b>{earned} / {milestones.length}</b></div>
                <div><span>XP this week</span><b className={s.up}>+{fmt(xp.weekXp ?? 0)}</b></div>
                <div><span>Unlocks</span><b>{unlockedCount} / {REWARDS.length}</b></div>
              </div>
              {L.canPrestige && wallet && (
                <button type="button" className={s.prestige} disabled={busy} data-testid="prestige"
                  onClick={async () => { setBusy(true); setNote(""); const r = await prestigeWithXp(wallet); setBusy(false); setNote(r.ok ? "Prestige up. Back to level 1." : r.reason || "Couldn't prestige."); }}>
                  {busy ? "Prestiging…" : `Prestige to ${PRESTIGE_NAMES[L.prestige + 1]}`}
                </button>
              )}
              {note && <p className={s.meta} role="status">{note}</p>}
              {next && (
                <div className={s.next}>
                  <RewardArt r={next} height={64} />
                  <div className={s.nextTx}>
                    <div className={s.ebGold}>Next unlock</div>
                    <div className={s.nextName}>{nextLabel(next)}</div>
                  </div>
                  <Link href="/profile" className={s.link}>See in Hangar</Link>
                </div>
              )}
            </>
          ) : (
            <div className={s.empty}>
              <Ring level={1} progress={0} />
              <div className={s.pilotTx}>
                <div className={s.pilotName}>Start at level 1</div>
                <div className={s.meta}>Sign in and boost a rocket. Your XP and level show up here.</div>
                <Link href="/play" prefetch={false} className={s.prestige}>Play now</Link>
              </div>
            </div>
          )}
        </section>

        <section className={`${s.card} ${s.missions}`} aria-label="Missions" data-testid="missions-panel">
          <div className={s.col}>
            <div className={s.colHead}><h2 className={s.h2}>Today</h2><span className={s.meta} suppressHydrationWarning>New in {untilLabel(shown.daily.resetsAt, now)}</span></div>
            <ul className={s.list}>{shown.daily.missions.map((m) => <Mission key={m.id} m={m} />)}</ul>
          </div>
          <div className={s.col}>
            <div className={s.colHead}><h2 className={s.h2}>This week</h2><span className={s.meta} suppressHydrationWarning>New in {untilLabel(shown.weekly.resetsAt, now)}</span></div>
            <ul className={s.list}>{shown.weekly.missions.map((m) => <Mission key={m.id} m={m} />)}</ul>
          </div>
          <div className={`${s.meta} ${s.missionsFoot}`}>Everyone gets the same missions. XP lands within a couple of minutes of the trade.</div>
        </section>
      </div>

      <section aria-label="Level rewards" className={s.sec} data-testid="level-rewards">
        <div className={s.secHead}>
          <h2 className={s.h2}>Level rewards</h2>
          <span className={s.meta}>{TROPHY_REWARDS.join(" and ")} trails come from trophies. Everything lands in Your rocket and flies in every mode.</span>
        </div>
        <div className={`${s.card} ${s.track}`}>
          {REWARDS.map((r) => {
            const got = open(r);
            const st = got ? s.got : r === next ? s.isNext : s.lock;
            return (
              <div key={r.id} className={`${s.rw} ${st}`} data-testid={`reward-${r.id}`}>
                <div className={s.rwLv}>{whenLabel(r)}</div>
                <div className={s.rwArt}><RewardArt r={r} height={150} /></div>
                <div className={s.rwName}>{r.name}</div>
                <p className={s.rwBlurb}>{r.blurb}</p>
                <span className={`${s.tb} ${got ? s.tbGot : r === next ? s.tbNext : ""}`}>{got ? "Unlocked" : r === next ? nextBadge(r) : lockLabel(r)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-label="Trophy case" className={s.sec}>
        <div className={s.secHead}>
          <div className={s.secTitle}><h2 className={s.h2}>Trophy case</h2><span className={s.meta}>{earned} of {milestones.length} earned</span></div>
          <div className={s.seg} role="tablist" aria-label="Show trophies">
            {(["all", "earned", "locked"] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? s.segOn : ""} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
        <div className={s.case}>
          {caseShown.map((m) => {
            const got = unlocks.get(m.id);
            const r = rarityStyle(m.rarity);
            const copy = MILESTONE_COPY[m.id] ?? { name: m.name, desc: "" };
            return (
              <article key={m.id} className={`${s.tro}${got ? ` ${s.troOn}` : ""}`} style={{ ["--rc" as string]: r.border }} data-testid={`milestone-${m.id}`}>
                <div className={s.troArt} aria-hidden>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={achievementIconPath(m.id)} alt="" width={84} height={84} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                </div>
                <div className={s.troRar}><i />{r.label}</div>
                <h3 className={s.troName}>{copy.name}</h3>
                <p className={s.troDesc}>{copy.desc}</p>
                <div className={s.troFoot}>
                  {got ? (
                    <span className={s.tfGot}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden><path d="M5 12l5 5 9-10" /></svg>Earned {new Date(got).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  ) : (
                    <span className={s.tfLock}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Locked</span>
                  )}
                  <span className={s.xpc}>+{fmt(milestoneXp(m.id, m.rarity))} XP</span>
                </div>
              </article>
            );
          })}
          {!caseShown.length && <p className={s.meta}>{filter === "earned" ? "No trophies yet. Boost a rocket to earn your first." : "Every trophy is yours."}</p>}
        </div>
      </section>
    </div>
  );
}

function Ring({ level, progress }: { level: number; progress: number }) {
  const r = 66, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, progress));
  return (
    <div className={s.ring}>
      <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden>
        <circle cx="75" cy="75" r={r} fill="rgba(10,12,18,.8)" stroke="rgba(232,234,238,.12)" strokeWidth="10" />
        {p > 0 && <circle cx="75" cy="75" r={r} fill="none" stroke="#F2C14E" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 75 75)" />}
      </svg>
      <div className={s.ringTx}><span>Level</span><b>{level}</b></div>
    </div>
  );
}
