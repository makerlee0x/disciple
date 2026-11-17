/**
 * /vs/<pilot>: a permanent Trading Duel challenge (maker 2026-11-16: "the challenge link should be a permanent challenge").
 * Every duel share points here instead of at a friend room that closes after 30 minutes. If the challenger is waiting in an
 * open friend room right now, the big button drops you into it. Otherwise you get a free warm-up duel against a labelled
 * bot, and (signed in) you can send them a duel request, which opens your own room and pings them (lib/push "duel").
 * ?ref=<wallet> rides along on every button, so whoever the challenger brings in counts as their referral (lib/referral).
 * Layout follows the Daily flight challenge (/d/<id>).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { challengerOf } from "@/lib/server/duel/challenge";
import { SITE_ORIGIN } from "@/lib/server/og/botPage";

export const dynamic = "force-dynamic";
type P = { params: Promise<{ pilot: string }>; searchParams: Promise<{ c?: string; ref?: string }> };

const load = async (p: P) => challengerOf((await p.params).pilot).catch(() => null);

export async function generateMetadata(p: P): Promise<Metadata> {
  const c = await load(p);
  const title = c ? `${c.name} challenged you to a trading duel` : "Trading Duel · DISCIPLE";
  const description = "1v1 on live BTC. One minute, most profit wins. Free to play, no sign-up.";
  const img = `${SITE_ORIGIN}/api/og/invite${c ? `?from=${encodeURIComponent(c.name.replace(/^@/, ""))}` : ""}`;
  // X player card (maker 2026-11-16): X reads these tags from the server HTML, shows the square thumbnail with a play
  // button, and on play frames /duel?embed=1 (a "Tap to play" screen, then a bot duel). 480 x 480 is the size X shows most
  // reliably; CARD_V busts X's card cache when the player changes.
  const CARD_V = 2;
  const slug = c ? c.slug : "", ref = c && /^0x[0-9a-f]{40}$/.test(c.pid) ? `&ref=${c.pid}` : "";
  const player = `${SITE_ORIGIN}/duel?embed=1&v=${CARD_V}${slug ? `&vs=${encodeURIComponent(slug)}` : ""}${ref}`;
  const square = `${SITE_ORIGIN}/og/duel-square.jpg?v=${CARD_V}`;
  return {
    title, description,
    openGraph: { title, description, images: [{ url: img, width: 1200, height: 630 }] },
    twitter: { card: "player", site: "@disciplevip", title, description, images: [square], // no streamUrl: that's for a raw video file, and this player is a page
      players: [{ playerUrl: player, width: 480, height: 480 } as unknown as { playerUrl: string; streamUrl: string; width: number; height: number }] },
  };
}

const game: React.CSSProperties = { fontFamily: "var(--dsc-font-game)" };
const tag = (c: string, b: string): React.CSSProperties => ({ ...game, padding: "5px 10px", borderRadius: 8, border: `1px solid ${b}`, color: c, fontWeight: 700, fontSize: 14 });
const btn = (gold: boolean): React.CSSProperties => ({ ...game, height: gold ? 64 : 52, borderRadius: 16, background: gold ? "#F2C14E" : "transparent", border: gold ? 0 : "1px solid #F3DFA8", color: gold ? "#121327" : "#F3DFA8", textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: gold ? 26 : 19, letterSpacing: 1, textTransform: "uppercase" });

export default async function DuelChallenge(p: P) {
  const c = await load(p);
  const ref = c && /^0x[0-9a-f]{40}$/.test(c.pid) ? `&ref=${c.pid}` : "";
  const name = c?.name ?? "A pilot";
  const initials = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const live = !!c?.openCode;
  const go = live ? `/turbo/duel?c=${c!.openCode}${ref}` : `/turbo/duel?first=1${ref}`;
  const r = c?.rating;
  return (
    <div data-testid="duel-challenge" style={{ position: "fixed", inset: 0, zIndex: 60, background: "#0B0C0E", color: "#F2F3F7", fontFamily: "var(--dsc-font-ui)", overflow: "auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/art/modes/duel.webp" alt="" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "72%", objectFit: "cover", objectPosition: "50% 30%" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(11,12,14,0.35) 0%, rgba(11,12,14,0.1) 28%, rgba(11,12,14,0.85) 58%, #0B0C0E 74%)" }} />
      <div style={{ position: "relative", minHeight: "100%", maxWidth: 440, margin: "0 auto", boxSizing: "border-box", padding: "calc(env(safe-area-inset-top, 0px) + 52px) 16px calc(env(safe-area-inset-bottom, 0px) + 32px)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Link href="/" aria-label="DISCIPLE" style={{ display: "inline-flex", textDecoration: "none" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- brand lockup */}
            <img src="/brand/disciple-lockup-horizontal-light.svg" alt="DISCIPLE" width={132} height={28} />
          </Link>
          <span data-testid="duel-challenge-state" style={{ padding: "5px 10px", borderRadius: 999, background: "rgba(18,19,39,0.78)", border: `1px solid ${live ? "#5FF0A0" : "#2E323A"}`, fontSize: 12, color: live ? "#5FF0A0" : "#D7D9E4" }}>{live ? "Waiting for you now" : "Free to play"}</span>
        </div>
        <div style={{ marginTop: "auto", paddingTop: 200, paddingLeft: 4, paddingRight: 4, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden style={{ ...game, width: 40, height: 40, borderRadius: "50%", boxSizing: "border-box", border: "2px solid #F2C14E", background: "#121327", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16 }}>{initials}</span>
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{name}</span>
              <span style={{ fontSize: 12, color: "#D7D9E4" }}>{r && r.games ? `${r.r.toLocaleString("en-US")} rating · ${r.w}-${r.l}${r.streak >= 2 ? ` · ${r.streak} win streak` : ""}` : "challenged you"}</span>
            </span>
          </div>
          <span data-testid="duel-challenge-head" style={{ ...game, fontWeight: 800, fontSize: 50, lineHeight: 0.92 }}>
            Beat <span style={{ color: "#F2C14E" }}>{name}</span> in a trading duel.
          </span>
          <span style={{ fontSize: 15, color: "#D7D9E4", lineHeight: 1.45 }}>
            {live ? `${name} is in the room right now. One minute on live BTC, most profit wins.` : `${name} isn't in a room right now. Warm up against a bot, then send them a duel request.`}
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={tag("#FF9CC4", "#FF6FAE")}>1V1</span>
            <span style={tag("#D7D9E4", "#2E323A")}>1 MIN</span>
            <span style={tag("#D7D9E4", "#2E323A")}>PRACTICE MONEY</span>
          </div>
        </div>
        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
          <Link data-testid="duel-challenge-go" href={go} style={btn(true)}>{live ? "Join the duel" : "Play a free duel"}</Link>
          {c && !live && <Link data-testid="duel-challenge-request" href={`/turbo/duel?request=${encodeURIComponent(c.slug)}${ref}`} style={btn(false)}>Send {name} a duel request</Link>}
          <span style={{ textAlign: "center", fontSize: 13, color: "#D7D9E4" }}>No wallet needed to play. Tap BOOST if BTC goes up, DUMP if it goes down.</span>
        </div>
      </div>
    </div>
  );
}
