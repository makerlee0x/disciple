"use client";
/**
 * "Your rocket" (canvas board "Rocket variety at launch"): the hulls and flares a pilot has earned, shown under the bay on
 * their own Hangar. Picking one equips it in this browser and the bay rocket updates. Locked looks show how to earn them.
 * The item shop waits for v2, so nothing here is bought.
 */
import SkinnedRocket from "@/components/SkinnedRocket";
import { FLARES, HULLS, isUnlocked, ruleLabel, type Look, type Progress } from "@/lib/unlocks";
import { thrusterById } from "@/lib/rocketSkin";

const RARITY: Record<Look["rarity"], string> = { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" };

function Flame({ id }: { id: string }) {
  const t = thrusterById(id), g = `hgf-${id}`;
  return (
    <svg viewBox="0 0 46 64" className="hg-flame" aria-hidden>
      <defs><linearGradient id={g} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset=".35" stopColor={t.flame} /><stop offset="1" stopColor={t.flame} stopOpacity="0" /></linearGradient></defs>
      <ellipse cx="23" cy="22" rx="15" ry="22" fill={t.flame} opacity=".25" />
      <path d="M15,8 C14,22 19,40 23,58 C27,40 32,22 31,8 Z" fill={`url(#${g})`} />
      <rect x="13" y="4" width="20" height="5" rx="2" fill="#2A2D35" />
    </svg>
  );
}

function Row({ title, sub, looks, on, progress, coin, pick, kind }: {
  title: string; sub: string; looks: readonly Look[]; on: string; progress: Progress | null; coin: string; kind: "hull" | "flare"; pick: (id: string) => void;
}) {
  return (
    <div className="hg-looks-row">
      <div className="hg-looks-h"><h3>{title}</h3><span>{sub}</span></div>
      <ul className="hg-looks" role="radiogroup" aria-label={title}>
        {looks.map((l) => {
          const open = progress ? isUnlocked(l.rule, progress) : l.rule.kind === "free";
          const sel = on === l.id;
          return (
            <li key={l.id}>
              <button type="button" role="radio" aria-checked={sel} disabled={!open} onClick={() => pick(l.id)}
                className={`hg-look r-${l.rarity}${sel ? " on" : ""}${open ? "" : " locked"}`} style={{ ["--sw" as string]: l.swatch }} data-testid={`look-${kind}-${l.id}`}>
                <span className="hg-look-art">{kind === "hull" ? <SkinnedRocket skin={l.id} coin={coin} height={104} /> : <Flame id={l.id} />}</span>
                <span className="hg-look-tx">
                  <span className="hg-look-r">{RARITY[l.rarity]}</span>
                  <b>{l.name}</b>
                  <span className="hg-look-s">{open ? (sel ? "Equipped" : "Tap to equip") : ruleLabel(l.rule)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function RocketLooks({ progress, hull, flare, coin, setHull, setFlare }: {
  progress: Progress | null; hull: string; flare: string; coin: string; setHull: (id: string) => void; setFlare: (id: string) => void;
}) {
  return (
    <section className="hg-sec" aria-labelledby="hg-looks" data-testid="rocket-looks">
      <header className="hg-sech"><div><h2 id="hg-looks" className="dsc3-h2">Your rocket</h2><span>Earn new looks by flying. Nothing here is for sale.</span></div></header>
      <Row title="Hull" sub="Your rocket when you launch" looks={HULLS} on={hull} progress={progress} coin={coin} pick={setHull} kind="hull" />
      <Row title="Engine flare" sub="The colour of your engine burn" looks={FLARES} on={flare} progress={progress} coin={coin} pick={setFlare} kind="flare" />
    </section>
  );
}
