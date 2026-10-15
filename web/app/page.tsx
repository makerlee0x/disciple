"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CHAIN,
  CURVE,
  DEMO_POOL,
  fmtUsd,
  gradProgress,
} from "@/lib/config";

type Coin = {
  id: string;
  name: string;
  tk: string;
  live?: boolean;
  mcap: number | null;
  chg: number | null;
  c: string;
};

const SAMPLE: Coin[] = [
  {
    id: DEMO_POOL.address,
    name: "Artificial Inu",
    tk: "AI / WETH",
    live: true,
    mcap: null,
    chg: null,
    c: "#ffe7a3",
  },
  {
    id: "sample-halo",
    name: "Halo Dog",
    tk: "HALO",
    mcap: 9.2e3,
    chg: -6.1,
    c: "#ffd0e0",
  },
  {
    id: "sample-limbo",
    name: "Limbo Cat",
    tk: "LIMBO",
    mcap: 14.8e3,
    chg: -12.7,
    c: "#e3d6ff",
  },
  {
    id: "sample-choir",
    name: "Choir of Frogs",
    tk: "CHOIR",
    mcap: 21.4e3,
    chg: 42.0,
    c: "#c9f5df",
  },
  {
    id: "sample-seraph",
    name: "Seraph Coin",
    tk: "SRPH",
    mcap: 28.6e3,
    chg: 18.4,
    c: "#cfe0ff",
  },
  {
    id: "sample-pearly",
    name: "Pearly Gates",
    tk: "GATE",
    mcap: 41.0e3,
    chg: 3.2,
    c: "#fff1c2",
  },
];

const LAUNCH_MS = 2300;
const RPC = CHAIN.rpcUrl;
const AI_POOL = DEMO_POOL.address;

export default function HomePage() {
  const router = useRouter();
  const [coins, setCoins] = useState<Coin[]>(SAMPLE);
  const [launching, setLaunching] = useState(false);
  const [lpStatus, setLpStatus] = useState("ON THE PAD · PICK A COIN TO LAUNCH");
  const [flash, setFlash] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const rocketRef = useRef<HTMLImageElement>(null);
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

  useEffect(() => {
    document.body.classList.add("home");
    return () => document.body.classList.remove("home");
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
          const rep = await fetch("/replay.json");
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
          const rep = await fetch("/replay.json");
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
      if (alive) setCoins(next);
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
      if (L < 0) {
        if (Math.random() < dt * 14)
          for (const sd of [-1, 1] as const)
            puff(
              b.x + sd * b.w * 0.35,
              b.y - 6,
              sd * (30 + Math.random() * 40),
              -(10 + Math.random() * 20),
              10 + Math.random() * 10,
              1.8 + Math.random(),
              false,
            );
      } else {
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
        rk!.style.transform = `translateX(-50%) translateY(${-lift}px) rotate(${(Math.random() - 0.5) * (L < 0.6 ? 1.5 : 0.6)}deg)`;
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
    (c: Coin) => {
      if (launchT.current >= 0) return;
      launchT.current = performance.now();
      setLaunching(true);
      setLpStatus(
        c.live
          ? "IGNITION · " + c.tk
          : "IGNITION · " + c.tk + " (sample → replay of the real AI pool)",
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => setFlash(true), LAUNCH_MS - 450);
      const q = new URLSearchParams();
      q.set("coin", c.live ? c.id : AI_POOL);
      if (!c.live) q.set("replay", "1");
      q.set("launched", "1");
      const addr = c.live ? c.id : AI_POOL;
      setTimeout(() => {
        router.push(`/coin/${addr}?${q.toString()}`);
      }, LAUNCH_MS);
    },
    [router],
  );

  return (
    <>
      <section
        ref={heroRef}
        id="hero"
        className={launching ? "launching" : ""}
        style={{
          position: "relative",
          height: "min(62vh, 560px)",
          minHeight: 360,
          overflow: "hidden",
          background:
            "#0b0f22 url(/assets/tier0.png) center 70% / cover no-repeat",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg,rgba(8,10,34,.15),rgba(8,10,34,.25) 60%,#05060c 100%)",
            pointerEvents: "none",
          }}
        />
        <div
          id="title"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 22,
            zIndex: 4,
            textAlign: "center",
            pointerEvents: "none",
            paddingLeft: "var(--ap-rail-w)",
            transition: "padding-left .22s",
          }}
          className="home-title"
        >
          <h1
            style={{
              margin: 0,
              font: "bold clamp(28px,5vw,52px) Georgia,serif",
              letterSpacing: ".12em",
              color: "#fff7df",
              textShadow: "0 0 26px rgba(255,220,150,.9)",
            }}
          >
            DISCIPLE
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: "#ffe7a3",
              fontSize: 12,
              letterSpacing: ".14em",
            }}
          >
            EVERY COIN IS A ROCKET · ALTITUDE = PRICE
          </p>
        </div>
        <div
          id="pad"
          style={{
            position: "absolute",
            left: "50%",
            bottom: "calc(16% - 14px)",
            width: "min(34vw, 300px)",
            height: 22,
            transform: "translateX(-50%)",
            zIndex: 2,
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse at center,rgba(255,236,190,.55),rgba(255,236,190,.08) 60%,transparent 72%)",
            boxShadow: "0 0 30px rgba(255,220,150,.35)",
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={rocketRef}
          id="rocket"
          src="/assets/rocket.png"
          alt="rocket on the launch pad"
          style={{
            position: "absolute",
            left: "50%",
            bottom: "16%",
            height: "min(30vh, 240px)",
            transform: "translateX(-50%)",
            zIndex: 3,
            filter: "drop-shadow(0 0 14px rgba(200,220,255,.55))",
          }}
        />
        <canvas
          ref={canvasRef}
          id="fx"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 2,
            pointerEvents: "none",
          }}
        />
        <div
          id="lpStatus"
          style={{
            position: "absolute",
            left: "50%",
            bottom: "6%",
            transform: "translateX(-50%)",
            zIndex: 4,
            fontSize: 12,
            color: "#ffe7a3",
            letterSpacing: ".1em",
            textShadow: "0 0 8px #000",
          }}
        >
          {lpStatus}
        </div>
      </section>

      <main style={{ maxWidth: 1180, margin: "-40px auto 40px", padding: "0 24px", position: "relative", zIndex: 5 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            margin: "0 0 12px",
          }}
        >
          <h2
            style={{
              margin: 0,
              font: "bold 20px Georgia,serif",
              color: "#fff7df",
            }}
          >
            Launchpad
          </h2>
          <span style={{ color: "rgba(220,228,255,.6)", fontSize: 11 }}>
            1 live pool on Robinhood Chain · other cards are SAMPLE data
          </span>
        </div>
        <div
          id="grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))",
            gap: 14,
          }}
        >
          {coins.map((c) => {
            const p = gradProgress(c.mcap);
            const grad = c.mcap != null && c.mcap >= CURVE.graduationMcap;
            const sold =
              p == null ? "" : ((p / 100) * CURVE.soldPctAtGrad).toFixed(0);
            const pl = grad
              ? "GRADUATED · past the Pearly Gates"
              : p == null
                ? "…"
                : `${p.toFixed(0)}% to graduation (${fmtUsd(CURVE.graduationMcap)}) · ${sold}% sold of ${CURVE.soldPctAtGrad}%`;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => launch(c)}
                className="coin-card"
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  display: "flex",
                  gap: 12,
                  padding: 14,
                  borderRadius: 16,
                  position: "relative",
                  background:
                    "radial-gradient(120% 90% at 0% 0%,rgba(255,244,214,.10),rgba(14,16,40,.9) 55%)",
                  border: c.live
                    ? "1px solid rgba(143,240,192,.6)"
                    : "1px solid rgba(255,231,163,.22)",
                  transition: "transform .12s,border-color .12s,box-shadow .12s",
                }}
              >
                <div
                  style={{
                    width: 58,
                    height: 58,
                    flex: "0 0 58px",
                    borderRadius: 14,
                    display: "grid",
                    placeItems: "center",
                    font: "bold 22px Georgia,serif",
                    color: "#1a1630",
                    background: `radial-gradient(circle at 35% 30%,#fff,${c.c})`,
                  }}
                >
                  {c.tk[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "inline-block",
                      marginBottom: 4,
                      fontSize: 9,
                      letterSpacing: ".1em",
                      padding: "2px 6px",
                      borderRadius: 6,
                      background: c.live
                        ? "rgba(143,240,192,.18)"
                        : "rgba(255,255,255,.08)",
                      color: c.live ? "#8ff0c0" : "rgba(220,228,255,.7)",
                    }}
                  >
                    {c.live ? "● LIVE · REAL POOL" : "SAMPLE"}
                  </span>
                  <div
                    style={{
                      fontWeight: "bold",
                      color: "#fff",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {c.name}
                  </div>
                  <div style={{ color: "#ffe7a3", fontSize: 11 }}>{c.tk}</div>
                  <div style={{ marginTop: 6, fontSize: 12, color: "#cfd8ff" }}>
                    MC {c.mcap ? fmtUsd(c.mcap) : "loading…"}{" "}
                    {c.chg != null && (
                      <span
                        style={{ color: c.chg >= 0 ? "#8ff0c0" : "#ff9fb8" }}
                      >
                        {c.chg >= 0 ? "▲" : "▼"} {Math.abs(c.chg).toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      height: 6,
                      borderRadius: 4,
                      background: "rgba(255,255,255,.1)",
                      overflow: "hidden",
                    }}
                  >
                    <i
                      style={{
                        display: "block",
                        height: "100%",
                        width: `${grad ? 100 : p || 0}%`,
                        background: "linear-gradient(90deg,#ffd98a,#fff7df)",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "rgba(220,228,255,.6)",
                      marginTop: 4,
                    }}
                  >
                    {pl}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
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
        body.side-open .home-title {
          padding-left: var(--ap-side-w) !important;
        }
        body.home.launching #hero,
        #hero.launching {
          animation: shake 0.08s linear infinite;
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
        .coin-card:hover,
        .coin-card:focus-visible {
          transform: translateY(-3px);
          border-color: rgba(255, 231, 163, 0.7) !important;
          box-shadow: 0 0 26px rgba(255, 220, 150, 0.22);
        }
      `}</style>
    </>
  );
}
