"use client";

import TouchGrass from "./flight/TouchGrass";
import SettingsMenu from "./flight/SettingsMenu";
import ExitConfirm from "./flight/ExitConfirm";
import { useT } from "@/lib/game/i18n";
import { LOADOUT_KEY } from "@/lib/rocketSkin";
import { useEffect, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";
import { gateFlightIcon } from "@/lib/flight/iconGate";
import { BASE_PATH, withBase } from "@/lib/base-path";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";
import { paperCurve } from "@/lib/flight/paperCurve";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { chooseRenderMode, startWorkerRender } from "@/lib/flight/workerBridge";
import GameChat from "@/components/gamechat/GameChat";
import HoldersBridge from "@/components/flight/HoldersBridge";
import PhoneHud from "@/components/flight/PhoneHud";

declare global {
  interface Window {
    REPLAY?: unknown;
    __flight?: unknown;
    __rocketDecal?: { canvas: HTMLCanvasElement; t0: number; fallback: boolean };
  }
}

/** = engine.js HUD_NARROW_W / HUD_NARROW_TOP (narrow screens: right HUD column below the MARKET CAP panel). */
const HUD_NARROW_W = 740, HUD_NARROW_TOP = 158;

type Props = {
  /** Query string without leading ? (replay, speed, zoom, source, launched, …) */
  search: string;
};

/**
 * Mounts the ported prototype flight engine (public/flight/engine.js).
 * Keeps canvas logic largely as-is; loads REPLAY from /replay.json when needed.
 */
export default function FlightCanvas({ search }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const [status, setStatus] = useState("Loading flight…");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let scriptEl: HTMLScriptElement | null = null;
    let stopWorker: (() => void) | null = null;
    let cv: HTMLCanvasElement | null = null;
    // The canvas is created per boot (not by React): a canvas can be transferred to a worker only once,
    // and Strict Mode / fallback need a fresh one.
    const freshCanvas = () => {
      cv?.remove();
      cv = document.createElement("canvas");
      cv.id = "c";
      wrapRef.current?.appendChild(cv);
      return cv;
    };
    const bootMain = async () => {
      freshCanvas();
      if (wrapRef.current) wrapRef.current.dataset.render = "main";
      const existing = document.querySelector('script[data-disciple-flight="1"]') as HTMLScriptElement | null;
      if (existing) {
        existing.remove();
        // Engine is an IIFE — remount requires a fresh script after clearing __flight
        delete window.__flight;
      }
      await new Promise<void>((resolve, reject) => {
        scriptEl = document.createElement("script");
        scriptEl.src = withBase("/flight/engine.js");
        scriptEl.dataset.discipleFlight = "1";
        scriptEl.async = false;
        scriptEl.onload = () => resolve();
        scriptEl.onerror = () => reject(new Error("Failed to load flight engine"));
        document.body.appendChild(scriptEl);
      });
    };
    // Worker path: resolves true when the engine is running in the worker, false → caller falls back.
    const bootWorker = (globals: Record<string, unknown>) =>
      new Promise<boolean>((resolve) => {
        const c = freshCanvas();
        if (wrapRef.current) wrapRef.current.dataset.render = "worker";
        let done = false;
        const finish = (ok: boolean, why?: string) => {
          if (done) return; done = true; clearTimeout(to);
          if (!ok) { console.warn("[flight] worker render unavailable, falling back to main thread:", why); stopWorker?.(); stopWorker = null; }
          resolve(ok);
        };
        const to = window.setTimeout(() => finish(false, "worker start timeout"), 10000);
        try {
          stopWorker = startWorkerRender({ canvas: c, wrap: wrapRef.current!, basePath: BASE_PATH, globals,
            onReady: () => finish(true), onError: (m) => (done ? console.error("[flight worker]", m) : finish(false, m)) });
        } catch (e) { finish(false, String(e)); }
      });

    async function boot() {
      try {
        // Sync URL search so engine's location.search / Q reads work if it falls back
        const qs = search.startsWith("?") ? search : search ? `?${search}` : "";
        if (qs && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          const incoming = new URLSearchParams(qs.slice(1));
          incoming.forEach((v, k) => url.searchParams.set(k, v));
          window.history.replaceState({}, "", url.pathname + "?" + url.searchParams.toString());
        }

        const needReplay =
          new URLSearchParams(qs.slice(1)).get("replay") === "1" ||
          new URLSearchParams(qs.slice(1)).get("source") === "replay";

        if (!window.REPLAY) {
          setStatus("Loading replay data…");
          const r = await fetch(withBase("/replay.json"));
          if (!r.ok) throw new Error("Failed to load replay.json");
          window.REPLAY = await r.json();
        } else if (needReplay && !window.REPLAY) {
          /* already handled */
        }

        if (cancelled) return;
        setStatus("Starting engine…");

        // Flight engine loads /assets/* — prefix for githack basePath.
        const globals = {
          __DISCIPLE_BASE_PATH__: BASE_PATH,
          // Ammo preset tiers (single source: lib/flight/ammoTiers.ts) — engine scales its presets from this.
          __AMMO_TIERS: AMMO_TIERS,
          // Paper fills (no wallet): bonding curve pre-grad / full-range pool post-grad, same math + params as the sim.
          __PAPER_CURVE: paperCurve(),
          // Chain flag for the engine. NOTE: no longer turns the simulated market on — it is OFF by default everywhere and never
          // runs on a live market (engine SIM block: pill on mock/replay, ?sim=on dev opt-in).
          __DISCIPLE_TESTNET: !!(ACTIVE_CHAIN as { testnet?: boolean }).testnet,
          REPLAY: window.REPLAY,
        };
        Object.assign(window, globals);
        // ?render=main|worker forces a path; default = main; worker is opt-in (?render=worker) and falls back to main if unsupported/failed
        const mode = chooseRenderMode(qs);
        const ok = mode === "worker" && (await bootWorker(globals));
        if (cancelled) return;
        if (!ok) await bootMain();

        if (!cancelled) setStatus("Live");
        // equipped Rocket Factory parts (cosmetic) → engine loadout; the token decal still owns the nose roundel
        if (!cancelled) try {
          const j = JSON.parse(localStorage.getItem(LOADOUT_KEY) || "{}") as { equipped?: Record<string, string>; stats?: Record<string, number> };
          const e = j.equipped || {};
          const f = window.__flight as { setLoadout?: (l: unknown) => unknown } | undefined;
          // forward-compatible: accessory (acc-<id>) + stats {thrust,glow,aura,launch,style} 0–10 are passed only when stored
          // (lib/rocketSkin.ts has no stats / accessories yet); the engine clamps, defaults to 5 and uses them for visuals only
          const accessory = typeof e.accessory === "string" && e.accessory ? e.accessory.replace(/^acc-/, "") : undefined;
          const stats = j.stats && typeof j.stats === "object" ? j.stats : undefined;
          if (e.body || e.thrusters || e.coin || accessory || stats) f?.setLoadout?.({ skin: (e.body || "").replace(/^body-/, ""), thruster: (e.thrusters || "").replace(/^thr-/, ""), noseCoin: (e.coin || "").replace(/^coin-/, ""),
            ...(accessory ? { accessory } : {}), ...(stats ? { stats } : {}) });
        } catch { /* no loadout */ }
      } catch (e) {
        if (!cancelled) {
          setErr(String((e as Error).message || e));
          setStatus("Error");
        }
      }
    }

    boot();
    // Token decal loads in parallel with the engine; never blocks flight.
    // AUDIT: ?icon only from the moderated store (/api/image/<sha>); anything else → plain-rocket fallback
    const icon = gateFlightIcon(new URLSearchParams(search).get("icon"));
    brandedRocket(icon).then(({ canvas, fallback }) => {
      if (!cancelled) window.__rocketDecal = { canvas, t0: performance.now(), fallback };
    });

    return () => {
      cancelled = true;
      stopWorker?.();
      cv?.remove();
      // Stop RAF / intervals by reloading is heavy; clear known hooks
      try {
        const src = (window.__flight as { source?: { stop?: () => void } } | undefined)
          ?.source;
        src?.stop?.();
      } catch {
        /* ignore */
      }
    };
  }, [search]);

  // The engine's DISCIPLE status box (top of the right column, 100px slot) is not drawn on coin pages (?source=disciple,
  // lee Oct 30 cleanup: engine.js STATUS_BOX) → GameChat (stacked on --ap-hud-rt + --ap-status-h) moves up into its slot.
  useEffect(() => {
    const st = document.documentElement.style;
    st.setProperty("--ap-status-h", new URLSearchParams(search).get("source") === "disciple" ? "0px" : "100px");
    return () => { st.removeProperty("--ap-status-h"); };
  }, [search]);

  // Top-right stacking: the site's wallet strip (top-right, height varies with its state) comes first,
  // then the in-canvas status column + crew panel (no Settings/Exit row since the Oct 30 cleanup). Measured, not hardcoded.
  useEffect(() => {
    let last = "";
    const tick = () => {
      const w = document.querySelector('[aria-label="wallet"]') as HTMLElement | null;
      const b = w ? Math.ceil(w.getBoundingClientRect().bottom) : 0;
      const vw = Math.round(wrapRef.current?.clientWidth || innerWidth);
      // the wallet strip's left edge in canvas px (engine hudTopLayout keeps the BUY panel clear of the cash / total cards);
      // the canvas starts at the sidebar edge, whatever its width (measured, not --ap-side-w)
      const wl = w ? Math.floor(w.getBoundingClientRect().left - (wrapRef.current?.getBoundingClientRect().left || 0)) : 0;
      if (`${b}:${vw}:${wl}:${colTop}` === last) return;
      last = `${b}:${vw}:${wl}:${colTop}`;
      (window as unknown as { __walletL?: number }).__walletL = wl;
      const row = Math.max(12, b + 8);
      // Phones: the in-canvas status column starts below the MARKET CAP panel (engine.js hudColTop, same 740/158 numbers),
      // so CrewPanel / GameChat (stacked on --ap-hud-rt) move down with it. Desktop unchanged.
      const hudRT = vw < HUD_NARROW_W ? Math.max(row + 10, HUD_NARROW_TOP) : row + 10;   // +10 gap (the 38px gear/✕ row is gone)
      const st = document.documentElement.style;
      st.setProperty("--ap-tr-top", row + "px");
      st.setProperty("--ap-hud-rt", Math.max(hudRT, colTop) + "px");   // the engine may move the column below the BUY panel
      (window as unknown as { __hudRT?: number }).__hudRT = hudRT;
    };
    let colTop = 0;
    const onCol = (e: Event) => { const t = +((e as CustomEvent<{ top?: number }>).detail?.top || 0); if (t !== colTop) { colTop = t; tick(); } };
    addEventListener("disciple:hudcol", onCol);
    tick();
    const id = window.setInterval(tick, 400);
    return () => { window.clearInterval(id); removeEventListener("disciple:hudcol", onCol); };
  }, []);

  // Simulated-market toggle (engine owns the state; this just mirrors + flips it).
  // `available` is false on a live market (real coin / live pool / wallet attached): the pill is hidden there (engine decides).
  const [sim, setSim] = useState<{ on: boolean; mode: string; available?: boolean }>({ on: false, mode: "off", available: false });
  useEffect(() => {
    const on = (e: Event) => setSim((e as CustomEvent).detail);
    window.addEventListener("disciple:simstate", on);
    return () => window.removeEventListener("disciple:simstate", on);
  }, []);
  // SIMULATOR route (?source=sim): the local market is the market — no display-offset toggle
  const isSimulator = new URLSearchParams(search).get("source") === "sim";
  const toggleSim = () =>
    window.dispatchEvent(new CustomEvent("disciple:sim", { detail: { mode: sim.on ? "off" : "on" } }));

  // Live chat overlay: live coin pages only (needs a coin address); in /flight/sim only with ?chatmock=1
  const chatCoin = (() => { const q = new URLSearchParams(search); const coin = q.get("coin") || "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(coin) && !(q.get("source") === "sim" && q.get("chatmock") === "1")) return null;
    if (q.get("source") === "sim" && q.get("chatmock") !== "1") return null;
    return coin || "0x000000000000000000000000000000000000c0de"; })();
  const q0 = new URLSearchParams(search);
  // EXIT CONFIRM is armed only while a flight is actually running (engine booted, no error) and not on a replay
  const isReplay = q0.get("replay") === "1" || q0.get("source") === "replay";
  const flightActive = status === "Live" && !err && !isReplay;

  return (
    <>
      <div
        id="wrap"
        ref={wrapRef}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          left: "var(--ap-rail-w, 64px)",
          overflow: "hidden",
        }}
        className="flight-wrap"
      >
      </div>
      {/* coin / game screen cleanup (lee, Oct 30): no ✕ or gear top right. Leave via the Sidebar (ExitConfirm still guards
          every link off a running flight); Settings = Sidebar "Settings" (SETTINGS_OPEN_EVENT) or ESC. */}
      {/* rail links, Back and tab close all go through the "Leave the mission?" confirm while flightActive */}
      <ExitConfirm active={flightActive} mode={isSimulator ? "sim" : "live"} />
      <TouchGrass />
      {/* ESC settings menu (ESC or the Sidebar's Settings; no gear button since the Oct 30 cleanup): Share, Hotkeys, Sound, Language, Display
          (Touch Grass, Orbs) and the Controls reference all live there now, not in the pill row below. */}
      <SettingsMenu coin={q0.get("coin") || ""} ticker={(q0.get("cs") || q0.get("ticker") || "").replace(/^\$/, "").toUpperCase()} icon={q0.get("icon")} simulator={isSimulator} />
      {chatCoin && <GameChat coin={chatCoin} />}
      {/* phones (<740px): v3 HUD — mcap pill, handle + PnL line, one swipe-up drawer (Feed/Holders/Chart/Crew/Chat/Position); desktop renders nothing */}
      <PhoneHud />
      {/^0x[0-9a-fA-F]{40}$/.test(q0.get("coin") || "") && q0.get("source") !== "sim" && <HoldersBridge coin={q0.get("coin") as string} />}
      <div className="ap-bc" data-testid="flight-pills" style={{ bottom: 142, zIndex: 25, display: "flex", gap: 8 }}>
        {!isSimulator && sim.available === true && <button
          type="button"
          data-testid="sim-toggle"
          title="Simulated market: random buys/sells keep the rocket moving when the pool is quiet. Visual only — never touches balances or PnL."
          onClick={toggleSim}
          className="ap-pill"
          style={{ color: sim.on ? "#d9ccff" : "rgba(220,228,255,.6)", borderColor: sim.on ? "rgba(201,184,255,.7)" : "rgba(255,255,255,.2)" }}
        >
          {sim.on ? t("sim.on") : t("sim.off")}
          {sim.mode === "auto" ? " " + t("sim.auto") : ""}
        </button>}
      </div>
      <div
        id="launchFade"
        style={{
          position: "fixed",
          inset: 0,
          background: "#fff8ea",
          pointerEvents: "none",
          zIndex: 50,
          opacity: 0,
          transition: "opacity .9s ease",
        }}
      />
      {err && (
        <div
          style={{
            position: "fixed",
            bottom: 60,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
            color: "#ff9fb8",
            fontFamily: "ui-monospace,monospace",
            fontSize: 12,
            background: "rgba(10,12,28,.85)",
            padding: "8px 14px",
            borderRadius: 10,
            border: "1px solid rgba(255,150,180,.4)",
          }}
        >
          {err}
        </div>
      )}
      <style jsx global>{`
        /* Flight page only (this style unmounts with the page): declutter the SITE wallet strip (components/WalletButton.tsx,
           SITE-owned; proper fix requested from SITE). Hidden here: the testnet faucet ("Get test funds" mint button = the
           only title-less button right before the address pill, and the "ETH faucet" links) and the wallet's Disconnect X
           (a second X next to the exit X; Sign out stays in the account popover). The low-gas status line is kept. */
        [aria-label="wallet"] button:not([title]):not([aria-label]):has(+ button[title]),
        [aria-label="wallet"] > span[title] a[href*="faucet"],
        [aria-label="wallet"] [role="menu"] > a[href*="faucet"],
        [aria-label="wallet"] button[aria-label="Disconnect"] {
          display: none !important;
        }
        body.side-open .flight-wrap {
          left: var(--ap-side-w, 248px) !important;
        }
        .ap-bc {
          position: fixed;
          left: calc(50% + var(--ap-rail-w, 64px) / 2);
          transform: translateX(-50%);
        }
        body.side-open .ap-bc {
          left: calc(50% + var(--ap-side-w, 248px) / 2) !important;
        }
        .ap-pill {
          padding: 6px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255, 231, 163, 0.6);
          background: rgba(10, 12, 28, 0.78);
          color: #ffe7a3;
          font: bold 11px ui-monospace, monospace;
          cursor: pointer;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }
        @media (max-width: 760px) {
          .flight-wrap,
          body.side-open .flight-wrap {
            left: 0 !important;
          }
          .ap-bc,
          body.side-open .ap-bc {
            left: 50% !important;
          }
        }
        #c {
          display: block;
          image-rendering: auto;
          touch-action: none; /* touch drag-to-steer (engine @drag-steer): no browser pan / zoom on the sky; mouse unaffected */
        }
        .flight-wrap[data-render="worker"] #c {
          width: 100%;
          height: 100%;
        }
      `}</style>
      <span className="sr-only">{status}</span>
    </>
  );
}
