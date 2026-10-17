"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CHAIN,
  DEMO_POOL,
  LAUNCHPAD_DEFAULT_FILTER,
} from "@/lib/config";
import { brandedRocketOn } from "@/lib/decal";
import hs from "@/components/home/hero.module.css";
import { isDeployed } from "@/lib/chains";
import { listLaunches, watchLaunchpad } from "@/lib/events";
import { withBase } from "@/lib/base-path";
import { recommendedPairs } from "@/lib/pairs";
import { sampleRockets, type Rocket } from "@/lib/launchpad";
import { SAYLOR_SQUARE } from "@/lib/pairArt";
import Launchpad from "@/components/launchpad/Launchpad";

const SEED: Rocket[] = [
  {
    id: DEMO_POOL.address,
    name: "Artificial Inu",
    tk: "AI",
    icon: "https://cdn.dexscreener.com/cms/images/U6RIzs8Fm7Jar6GE?width=256&height=256&quality=95&format=png",
    live: true,
    mcap: null,
    chg: null,
    c: "#C9CED6",
    pair: "OTHER",
    pairSym: "ETH",
    creator: "Robinhood pool",
    stats: { volume24hUsd: 42_000, ageHours: 900, holders: 640, liquidityUsd: 60_000 },
  },
  {
    // Hero SAMPLE: SAYLOR paired with STRATEGY — kept at the top of Altitude + Trending.
    id: "sample-saylor",
    name: "Saylor",
    tk: "SAYLOR",
    icon: withBase(SAYLOR_SQUARE),
    mcap: 2.4e6,
    chg: 21.0,
    c: "#C9CED6",
    pair: "STRATEGY",
    pairSym: "STRATEGY",
    creator: "GildedQuietOwl",
    graduated: true,
    seed: 4242,
    stats: { volume24hUsd: 61_000, ageHours: 300, holders: 1_480, liquidityUsd: 240_000 },
  },
  {
    id: "sample-halo",
    name: "Halo Dog",
    tk: "HALO",
    icon: withBase("/test-icons/wide.png"),
    mcap: 9.2e3,
    chg: -6.1,
    c: "#ffd0e0",
    pair: "USDG",
    pairSym: "USDG",
    stats: { volume24hUsd: 800, ageHours: 5, holders: 22, liquidityUsd: 1_200 },
  },
  {
    id: "sample-limbo",
    name: "Limbo Cat",
    tk: "LIMBO",
    icon: withBase("/test-icons/transparent.png"),
    mcap: 14.8e3,
    chg: -12.7,
    c: "#e3d6ff",
    pair: "OTHER",
    pairSym: "ETH",
    stats: { volume24hUsd: 3_100, ageHours: 30, holders: 61, liquidityUsd: 2_900 },
  },
  {
    id: "sample-choir",
    name: "Choir of Frogs",
    tk: "CHOIR",
    icon: withBase("/assets/tier4.png"),
    mcap: 21.4e3,
    chg: 42.0,
    c: "#c9f5df",
    pair: "OTHER",
    pairSym: "PONS",
    stats: { volume24hUsd: 18_000, ageHours: 40, holders: 140, liquidityUsd: 7_400 },
  },
  {
    id: "sample-seraph",
    name: "Seraph Coin",
    tk: "SRPH",
    mcap: 28.6e3,
    chg: 18.4,
    c: "#C9CED6",
    pair: "OTHER",
    pairSym: "NVDA",
    stats: { volume24hUsd: 6_000, ageHours: 12, holders: 95, liquidityUsd: 6_100 },
  },
  {
    id: "sample-pearly",
    name: "Pearly Gates",
    tk: "GATE",
    mcap: 41.0e3,
    chg: 3.2,
    c: "#E8EAEE",
    pair: "STRATEGY",
    pairSym: "STRATEGY",
    stats: { volume24hUsd: 25_000, ageHours: 80, holders: 220, liquidityUsd: 12_000 },
  },
];

/** Hand-made SAMPLE cards + generated SAMPLE rockets so the launchpad is exercised at 500+ items. */
const SAMPLE: Rocket[] = [...SEED, ...sampleRockets(600, withBase)];

const LAUNCH_MS = 2300;
/** Lit chrome rocket layer exported from the approved hero mock (hero.py, rocket-wet-full.png master). */
const HERO_ROCKET = "/hero/rocket.webp";
/** Pad-light glow points (% of plate), from hero.py's lamp layout; mobile plate shows only the inner two. */
const LAMPS: [number, number, string][] = [
  [53.806, 84.782, "d"], [63.806, 87.103, "d"], [83.493, 87.103, "d"], [93.181, 84.782, "d"],
  [14.103, 88.536, "m"], [94.872, 88.536, "m"],
];
const RPC = CHAIN.rpcUrl;
const AI_POOL = DEMO_POOL.address;

const short = (a: string) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
function pairOf(quote: string): Rocket["pair"] {
  const q = (quote || "").toLowerCase();
  const ps = recommendedPairs();
  if (!q || /^0x0+$/.test(q) || q === ps[0]?.address.toLowerCase()) return "STRATEGY";
  if (ps[1] && q === ps[1].address.toLowerCase()) return "USDG";
  return "OTHER";
}
function pairSymOf(quote: string): string {
  const k = pairOf(quote);
  if (k === "OTHER") return short(quote);
  return k === "USDG" ? (recommendedPairs()[1]?.symbol ?? "USDG") : "STRATEGY";
}

export default function HomePage() {
  const router = useRouter();
  const [coins, setCoins] = useState<Rocket[]>(SAMPLE);
    const [launching, setLaunching] = useState(false);
  const [lpStatus, setLpStatus] = useState("ON THE PAD · PICK A ROCKET TO BOARD");
  const [flash, setFlash] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const rocketRef = useRef<HTMLImageElement>(null);
  const liftRef = useRef<HTMLDivElement>(null);
  const [padDecal, setPadDecal] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const launchT = useRef(-1);
  const particles = useRef<
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      s: number;
      life: number;
      max: number;
      hot: boolean;
    }[]
  >([]);
  const lastRef = useRef(0);

  // Idle pad rocket is the clean lit chrome (approved hero mock); picking a card paints that coin onto it.

  useEffect(() => {
    document.body.classList.add("home");
    // Chrome strip stays transparent while it sits over the hero scene.
    const onScroll = () => {
      const h = heroRef.current?.offsetHeight ?? 0;
      document.body.classList.toggle("home-top", window.scrollY < h - 64);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      document.body.classList.remove("home", "home-top");
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // DISCIPLE launches (Launched events since the deployment start block) → live rocket cards, refreshed.
  useEffect(() => {
    if (!isDeployed()) return;
    let alive = true;
    const load = async () => {
      try {
        const list = await listLaunches();
        if (!alive) return;
        const live: Rocket[] = list.map((x) => ({
          id: x.token, name: x.name, tk: x.ticker, live: true, mcap: x.mcapUsd, chg: null, c: "#E8EAEE",
          icon: /^https?:|^data:|^\//.test(x.imageURI) ? x.imageURI : undefined,
          pair: pairOf(x.quote), pairSym: pairSymOf(x.quote), creator: short(x.creator), graduated: x.graduated, born: Number(x.block),
          stats: { volume24hUsd: 0, ageHours: 0, holders: 1, liquidityUsd: 0 }, // TODO: indexer stats
        }));
        setCoins((cs) => [...live, ...cs.filter((c) => !live.some((l) => l.id.toLowerCase() === c.id.toLowerCase()))]);
      } catch { /* RPC hiccup → keep current list */ }
    };
    load();
    const iv = setInterval(load, 20000);
    const stop = watchLaunchpad((e) => { if (e.type === "Launch") load(); });
    return () => { alive = false; clearInterval(iv); stop(); };
  }, []);

  // Live AI/WETH mcap from RPC slot0
  useEffect(() => {
    let alive = true;
    async function live() {
      const next = [...SAMPLE];
      const ai = { ...next[0] };
      try {
        const r = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: AI_POOL, data: "0x3850c7bd" }, "latest"],
          }),
        });
        const j = await r.json();
        const s = Number(BigInt("0x" + j.result.slice(2, 66))) / 2 ** 96;
        let ethUsd = 2400;
        let supply = 1e9;
        try {
          const rep = await fetch(withBase("/replay.json"));
          const R = await rep.json();
          ethUsd = R.ethUsd || ethUsd;
          supply = R.totalSupply || supply;
        } catch {
          /* ignore */
        }
        const priceUsd = ethUsd / (s * s);
        ai.mcap = priceUsd * supply;
      } catch {
        try {
          const rep = await fetch(withBase("/replay.json"));
          const R = await rep.json();
          const sw = R.swaps || [];
          const last = sw[sw.length - 1];
          if (last?.price) ai.mcap = last.price * (R.totalSupply || 1e9);
        } catch {
          /* ignore */
        }
      }
      try {
        const d = await (
          await fetch(
            "https://api.dexscreener.com/latest/dex/pairs/robinhood/" + AI_POOL,
          )
        ).json();
        const p = (d.pairs || [d.pair])[0];
        if (p?.priceChange?.h24 != null) ai.chg = +p.priceChange.h24;
      } catch {
        /* ignore */
      }
      next[0] = ai;
      if (alive) setCoins((cs) => cs.map((c) => (c.id === next[0].id ? next[0] : c)));
    }
    live();
    const iv = setInterval(live, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // Idle steam + blast-off FX
  useEffect(() => {
    const cv = canvasRef.current;
    const hero = heroRef.current;
    const rk = rocketRef.current;
    if (!cv || !hero || !rk) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    lastRef.current = performance.now();

    function size() {
      cv!.width = hero!.clientWidth;
      cv!.height = hero!.clientHeight;
    }
    size();
    const onResize = () => size();
    window.addEventListener("resize", onResize);

    function base() {
      const r = rk!.getBoundingClientRect();
      const h = hero!.getBoundingClientRect();
      return {
        x: r.left - h.left + r.width / 2,
        y: r.bottom - h.top - r.height * 0.04,
        w: r.width,
      };
    }
    function puff(
      x: number,
      y: number,
      vx: number,
      vy: number,
      s: number,
      life: number,
      hot: boolean,
    ) {
      particles.current.push({ x, y, vx, vy, s, life, max: life, hot });
    }

    function tick(now: number) {
      const dt = Math.min(0.05, (now - lastRef.current) / 1000);
      lastRef.current = now;
      const b = base();
      const L =
        launchT.current < 0 ? -1 : (now - launchT.current) / 1000;
      if (L >= 0) {
        const n = L < 0.6 ? 8 : 16;
        for (let i = 0; i < n; i++)
          puff(
            b.x + (Math.random() - 0.5) * b.w * 0.5,
            b.y,
            (Math.random() - 0.5) * (L < 0.6 ? 160 : 520),
            -(Math.random() * 60) + (L > 0.6 ? 40 : 0),
            14 + Math.random() * 30,
            1.2 + Math.random() * 1.4,
            Math.random() < 0.35,
          );
        const lift = L < 0.6 ? 0 : Math.pow(L - 0.6, 2) * 900;
        if (liftRef.current) liftRef.current.style.transform = `translateY(${-lift}px)`;
      }
      ctx!.clearRect(0, 0, cv!.width, cv!.height);
      for (const p of particles.current) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.985;
        p.vy -= 12 * dt;
        p.life -= dt;
        p.s += dt * 24;
        const a = Math.max(0, p.life / p.max);
        const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.s);
        const c = p.hot ? "255,214,150" : "236,240,255";
        g.addColorStop(0, `rgba(${c},${(p.hot ? 0.55 : 0.32) * a})`);
        g.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = g;
        ctx!.fillRect(p.x - p.s, p.y - p.s, 2 * p.s, 2 * p.s);
      }
      if (L >= 0) {
        const fl = 0.6 + 0.4 * Math.random();
        const r = base();
        const fg = ctx!.createRadialGradient(
          r.x,
          r.y,
          0,
          r.x,
          r.y,
          (40 + L * 80) * fl,
        );
        fg.addColorStop(0, "rgba(255,250,225,.9)");
        fg.addColorStop(1, "rgba(255,170,90,0)");
        ctx!.fillStyle = fg;
        ctx!.fillRect(r.x - 200, r.y - 200, 400, 400);
      }
      particles.current = particles.current
        .filter((p) => p.life > 0)
        .slice(-500);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const launch = useCallback(
    (c: Rocket) => {
      if (launchT.current >= 0) return;
      launchT.current = performance.now();
      // Fetch + composite decal in parallel with ignition; never blocks the launch.
      brandedRocketOn(withBase(HERO_ROCKET), c.icon, 1800).then(({ canvas }) => { try { setPadDecal(canvas.toDataURL()); } catch { /* tainted → keep prior */ } });
      setLaunching(true);
      setLpStatus(
        c.live
          ? "IGNITION · " + c.tk
          : "IGNITION · " + c.tk + " (sample → replay flight)",
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => setFlash(true), LAUNCH_MS - 450);
      const q = new URLSearchParams();
      q.set("coin", c.live ? c.id : AI_POOL);
      if (!c.live) q.set("replay", "1");
      q.set("launched", "1");
      if (c.icon) q.set("icon", c.icon);
      if (c.pairSym) q.set("pair", c.pairSym);
      q.set("nm", c.name);
      q.set("cs", c.tk);
      const addr = c.live ? c.id : AI_POOL;
      setTimeout(() => {
        router.push(`/coin/${addr}?${q.toString()}`);
      }, LAUNCH_MS);
    },
    [router],
  );

  return (
    <>
      {/* LCP: preload the plate for the active breakpoint (React hoists these into <head>) */}
      <link rel="preload" as="image" type="image/avif" media="(min-width: 761px)" fetchPriority="high"
        imageSrcSet={`${withBase("/hero/plate-desktop-1440.avif")} 1440w, ${withBase("/hero/plate-desktop.avif")} 2880w`} imageSizes="max(100vw, 1440px)" />
      <link rel="preload" as="image" type="image/avif" media="(max-width: 760px)" fetchPriority="high" href={withBase("/hero/plate-mobile.avif")} />
      <section ref={heroRef} id="hero" className={`${hs.hero}${launching ? " launching " + hs.launching : ""}`}>
        <div className={hs.stage}>
          <div className={hs.inner}>
            <picture>
              <source media="(max-width: 760px)" type="image/avif" srcSet={withBase("/hero/plate-mobile.avif")} />
              <source media="(max-width: 760px)" type="image/webp" srcSet={withBase("/hero/plate-mobile.webp")} />
              <source type="image/avif" srcSet={`${withBase("/hero/plate-desktop-1440.avif")} 1440w, ${withBase("/hero/plate-desktop.avif")} 2880w`} sizes="max(100vw, 1440px)" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={hs.plate}
                src={withBase("/hero/plate-desktop.webp")}
                srcSet={`${withBase("/hero/plate-desktop-1440.webp")} 1440w, ${withBase("/hero/plate-desktop.webp")} 2880w`}
                sizes="max(100vw, 1440px)"
                width={2880}
                height={1120}
                alt=""
                fetchPriority="high"
                decoding="async"
              />
            </picture>
            <div className={`${hs.fog} ${hs.fogA}`} style={{ backgroundImage: `url(${withBase("/hero/fog.webp")})` }} aria-hidden />
            <div className={`${hs.fog} ${hs.fogB}`} style={{ backgroundImage: `url(${withBase("/hero/fog.webp")})` }} aria-hidden />
            {LAMPS.map(([x, y, mobile], i) => (
              <span key={i} className={`${hs.lamp} ${mobile === "m" ? hs.lampM : hs.lampD}`} style={{ left: `${x}%`, top: `${y}%` }} aria-hidden />
            ))}
            <div id="pad" className={hs.rocket}>
              <div className={hs.pool} aria-hidden />
              <div className={hs.refl} aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={withBase(HERO_ROCKET)} alt="" width={195} height={540} />
              </div>
              <div ref={liftRef} className={hs.lift}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={rocketRef}
                  id="rocket"
                  className={hs.rocketImg}
                  src={withBase(HERO_ROCKET)}
                  alt="rocket on the launch pad"
                  width={195}
                  height={540}
                />
                {padDecal && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={padDecal.length + padDecal.slice(-24)} src={padDecal} alt="" className={`${hs.decal} pad-decal`} />
                )}
              </div>
              <div className={hs.vapor} aria-hidden><span /><span /><span /><span /></div>
            </div>
          </div>
          <div id="lpStatus" className={hs.padline}>{lpStatus}</div>
        </div>
        <canvas ref={canvasRef} id="fx" className={hs.fx} />
        <div className={hs.scrim} aria-hidden />
        <div id="title" className={`${hs.copy} home-title`}>
          <div className={hs.rule} aria-hidden />
          <h1 className={hs.title}>
            <span>Launch a rocket.</span>
            <br />
            <span>
              Send your coin<span className={hs.mbr}><br /></span> to the moon.
            </span>
          </h1>
          <p className={hs.sub}>
            Every rocket is paired with<span className={hs.mbr}><br /></span> a coin you believe in.
          </p>
        </div>
      </section>

      <main className="lp-wrap" style={{ maxWidth: 1440, margin: "14px auto 40px", padding: "0 24px", position: "relative", zIndex: 5 }}>
        <Launchpad coins={coins} onPick={launch} defaultVerified={LAUNCHPAD_DEFAULT_FILTER} />
      </main>
      <div
        id="flash"
        style={{
          position: "fixed",
          inset: 0,
          background: "#fff8ea",
          opacity: flash ? 1 : 0,
          pointerEvents: "none",
          zIndex: 60,
          transition: "opacity .45s ease",
        }}
      />
      <style jsx global>{`
        body.home.launching #hero,
        #hero.launching {
        }
        @keyframes shake {
          0% {
            transform: translate(0, 0);
          }
          25% {
            transform: translate(-4px, 2px);
          }
          50% {
            transform: translate(3px, -3px);
          }
          75% {
            transform: translate(-2px, -1px);
          }
          100% {
            transform: translate(2px, 3px);
          }
        }
        .pad-decal {
          animation: decalIn 0.3s ease both;
        }
        @keyframes decalIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .rocket-card:hover,
        .rocket-card:focus-visible {
          transform: translateY(-3px);
          border-color: rgba(201, 206, 214, 0.7) !important;
          box-shadow: 0 0 26px rgba(201, 206, 214, 0.22);
        }
      `}</style>
    </>
  );
}
