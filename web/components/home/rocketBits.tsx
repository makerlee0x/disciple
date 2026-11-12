/** Shared lobby rocket pieces (Lobby, LiveCard, RocketGrid): the flight link, each rocket's light colour and its mark. */
import type { CSSProperties } from "react";
import { isStoreSrc } from "@/lib/coinImages";
import type { HomeCoin } from "@/lib/home/trending";

/** Flight page link (the query the coin page reads for its first paint). */
export function flightHref(c: HomeCoin) {
  const q = new URLSearchParams();
  q.set("coin", c.token);
  q.set("launched", "1");
  if (c.icon) q.set("icon", c.icon);
  if (c.pairSym) q.set("pair", c.pairSym);
  q.set("nm", c.name);
  q.set("cs", c.ticker);
  return `/coin/${c.token}?${q.toString()}`;
}

/** Each rocket's light colour (its glow, tier tag and mark), fixed per coin. Lobby mockup palette. */
const LIGHTS = ["#70D9CC", "#B7A0FB", "#FF7A3D", "#DA9CED", "#5BBFE8", "#73B1E6", "#FFD84D", "#5FF0A0", "#44D4E2", "#F3DFA8"];
export function lightOf(token: string) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return LIGHTS[(h >>> 0) % LIGHTS.length];
}
export const lit = (c: HomeCoin) => ({ ["--c" as string]: lightOf(c.token) }) as CSSProperties;
export const orbitPct = (c: HomeCoin) => (c.graduated ? 100 : Math.max(0, Math.min(100, (c.progressBps ?? 0) / 100)));
export const pct = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
const initial = (c: HomeCoin) => (c.name.trim()[0] ?? c.ticker[0] ?? "?").toUpperCase();

/** The coin's mark: its own (moderated) image, else its initial on its light colour. Style via className. */
export function Mark({ c, className }: { c: HomeCoin; className?: string }) {
  return (
    <span className={className} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {isStoreSrc(c.icon) ? <img src={c.icon} alt="" loading="lazy" decoding="async" /> : initial(c)}
    </span>
  );
}
