/**
 * /d/{id}?c={runId}: a Daily flight challenge (the approved Challenge board). The challenger's name and multiple come
 * from their stored, server-verified run. Today's daily opens the scored flight; an older one flies its exact market as
 * practice. og:image is the share card (app/api/daily/card).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { dailyOpen, pilotOf, readRun } from "@/lib/server/daily";
import LevelRing from "@/components/xp/LevelRing";
import { dailySeed, dailyToday, fmtMultiple, DAILY } from "@/lib/sim/daily";
import { cloneConfig, PLAYER } from "@/lib/sim/config";

export const dynamic = "force-dynamic";
type P = { params: Promise<{ id: string }>; searchParams: Promise<{ c?: string }> };
const RUN_RE = /^[0-9a-f]{16}$/;

async function load({ params, searchParams }: P) {
  const id = Number((await params).id), c = (await searchParams).c;
  if (!Number.isInteger(id) || id < 1 || id > dailyToday()) return null;
  const run = c && RUN_RE.test(c) ? await readRun(id, c).catch(() => null) : null;
  const pilot = run ? await pilotOf(id, run).catch(() => ({ name: run.name, level: null, prestige: 0, progress: 0 })) : null;
  return { id, run, pilot };
}

export async function generateMetadata(p: P): Promise<Metadata> {
  const d = await load(p); if (!d) return { title: "Daily flight · DISCIPLE" };
  const title = d.run ? `${d.pilot?.name ?? d.run.name} cashed out at ${fmtMultiple(d.run.score.multiple)}. Beat it.` : `Daily flight #${d.id} · DISCIPLE`;
  const img = `/api/daily/card?id=${d.id}${d.run ? `&run=${d.run.runId}` : ""}`;
  const description = "Free play. Same market for everyone, one scored run. No sign-in, no wallet.";
  return { title, description, openGraph: { title, description, images: [{ url: img, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, description, images: [img] } };
}

const game: React.CSSProperties = { fontFamily: "var(--dsc-font-game)" };
const tag = (c: string, b: string): React.CSSProperties => ({ ...game, padding: "5px 10px", borderRadius: 8, border: `1px solid ${b}`, color: c, fontWeight: 700, fontSize: 14 });

export default async function DailyChallenge(p: P) {
  const d = await load(p);
  const id = d?.id ?? dailyToday(), run = d?.run ?? null, pilot = d?.pilot ?? null;
  const label = cloneConfig().difficulties[DAILY.difficulty].label.toUpperCase();
  // today's open daily is scored; a closed one is flown on its exact seed as practice
  const href = dailyOpen(id) && id === dailyToday() ? `/flight/sim?daily=1${run ? `&c=${run.runId}` : ""}` : `/flight/sim?difficulty=${DAILY.difficulty}&seed=${dailySeed(id)}&autostart=1${run ? `&d=${id}&c=${run.runId}` : ""}`;
  const name = pilot?.name ?? run?.name ?? "", initials = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return (
    <div data-testid="daily-challenge" style={{ position: "fixed", inset: 0, zIndex: 60, background: "#0B0C0E", color: "#F2F3F7", fontFamily: "var(--dsc-font-ui)", overflow: "auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/free-play/challenge-sky.webp" alt="The chrome rocket climbing through night clouds" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "78.7%", objectFit: "cover" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(11,12,14,0.35) 0%, rgba(11,12,14,0.1) 30%, rgba(11,12,14,0.85) 62%, #0B0C0E 78%)" }} />
      <div style={{ position: "relative", minHeight: "100%", maxWidth: 440, margin: "0 auto", boxSizing: "border-box", padding: "calc(env(safe-area-inset-top, 0px) + 52px) 16px calc(env(safe-area-inset-bottom, 0px) + 32px)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Link href="/flight/sim" style={{ ...game, fontWeight: 800, fontSize: 22, letterSpacing: 3, color: "#F2F3F7", textDecoration: "none" }}>DISCIPLE</Link>
          <span style={{ padding: "5px 10px", borderRadius: 999, background: "rgba(18,19,39,0.78)", border: "1px solid #2E323A", fontSize: 12, color: "#D7D9E4" }}>Free play</span>
        </div>
        <div style={{ marginTop: "auto", paddingTop: 200, paddingLeft: 4, paddingRight: 4, display: "flex", flexDirection: "column", gap: 14 }}>
          {run && <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {pilot?.level != null ? <span data-testid="daily-challenge-level" aria-label={`Level ${pilot.level}`} style={{ borderRadius: "50%", background: "#121327", display: "inline-flex" }}><LevelRing info={{ level: pilot.level, progress: pilot.progress, prestige: pilot.prestige }} size={40} /></span>
              : <span aria-hidden style={{ ...game, width: 40, height: 40, borderRadius: "50%", boxSizing: "border-box", border: "2px solid #F2C14E", background: "#121327", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16 }}>{initials}</span>}
            <span style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: 15, fontWeight: 600 }}>{name}</span><span style={{ fontSize: 12, color: "#D7D9E4" }}>challenged you</span></span>
          </div>}
          <span data-testid="daily-challenge-head" style={{ ...game, fontWeight: 800, fontSize: 50, lineHeight: 0.92 }}>
            {run ? <>Beat <span style={{ color: "#F2C14E" }}>{fmtMultiple(run.score.multiple)}</span> on this exact flight.</> : <>Daily flight <span style={{ color: "#F2C14E" }}>#{id}</span>. Cash out at 2×.</>}
          </span>
          <span style={{ fontSize: 15, color: "#D7D9E4", lineHeight: 1.45 }}>Same market, same crew. Their ghost flies next to you, so you&apos;ll see when they cashed out.</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={tag("#FFB48F", "#FF7A3D")}>{label}</span>
            <span style={tag("#D7D9E4", "#2E323A")}>{PLAYER.dailyMinutes} MIN</span>
            <span style={tag("#D7D9E4", "#2E323A")}>${PLAYER.startBalanceUsd} PRACTICE CASH</span>
          </div>
        </div>
        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
          <Link data-testid="daily-challenge-go" href={href} style={{ ...game, height: 64, borderRadius: 16, background: "#F2C14E", color: "#121327", textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 26, letterSpacing: 1 }}>TAKE THE CHALLENGE</Link>
          <span style={{ textAlign: "center", fontSize: 13, color: "#D7D9E4" }}>No sign-in, no wallet. Tap BOOST to climb, DUMP to cash out.</span>
        </div>
      </div>
    </div>
  );
}
