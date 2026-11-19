/** The level rewards track (maker 2026-11-17, one collection for every mode): what a level or a Prestige gives, in order. */
import { withBase } from "@/lib/base-path";
import { HULL_NAMES, PRESTIGE_HULL, REWARDS as COLLECTION_REWARDS, STARTER_SKIN, itemById, skinArt, skinId, trailArt, trailId } from "@/lib/collection";
import type { Progress } from "@/lib/unlocks";

export type Rule = { kind: "free" } | { kind: "level"; level: number } | { kind: "prestige"; prestige: number };
export type Reward = { id: string; kind: "skin" | "trail"; name: string; rule: Rule };

const reward = (id: string, rule: Rule): Reward => {
  const it = itemById(id)!;
  const name = it.kind === "skin" ? (it.hull === PRESTIGE_HULL ? "Ring-tail hull" : `${HULL_NAMES[it.hull!]} | ${it.name}`) : `${it.name} trail`;
  return { id, kind: it.kind === "skin" ? "skin" : "trail", name, rule };
};
export const REWARDS: Reward[] = [
  reward(STARTER_SKIN, { kind: "free" }),
  ...COLLECTION_REWARDS.filter((r) => r.rule.kind === "level").map((r) => reward(r.item, r.rule as Rule)),
  reward(skinId(PRESTIGE_HULL, "white-gloss"), { kind: "prestige", prestige: 1 }),
  reward(trailId("halo"), { kind: "prestige", prestige: 2 }),
];
export const isOpen = (r: Rule, p: Progress | null) =>
  r.kind === "free" ? true : !p ? false : r.kind === "level" ? p.prestige > 0 || p.level >= r.level : p.prestige >= r.prestige;
export const whenLabel = (r: Reward) => (r.rule.kind === "prestige" ? `Prestige ${r.rule.prestige}` : `LV ${r.rule.kind === "level" ? r.rule.level : 1}`);

export function RewardArt({ r, height }: { r: Reward; height: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  if (r.kind === "skin") return <img src={withBase(skinArt(r.id))} alt="" style={{ height, width: "auto", objectFit: "contain" }} />;
  return <span className="hgu-plume" aria-hidden style={{ height, width: height / 3, backgroundImage: `url(${withBase(trailArt(r.id.replace(/^trail-/, "")))})` }} />;
}
