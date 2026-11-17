"use client";
/** Password screen in front of /turbo while it's pre-launch. On the right password the server sets a cookie and the page
 *  reloads the page the pilot asked for (/turbo opens as the play sample: live prices, sample fuel). */
import { useEffect, useState } from "react";
import { withBase } from "@/lib/base-path";
import s from "./gate.module.css";

export default function TurboGate({ duelOnly = false }: { duelOnly?: boolean } = {}) {
  const [pw, setPw] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "wrong" | "slow">("idle");
  // A friend's duel link (/turbo/duel?c=CODE) skips the password: /api/turbo/invite checks the code and lets them in
  // (maker, 2026-11-15). ?closed=1 means the code wasn't open, so show the password form with a note instead of looping.
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("closed") === "1") { setClosed(true); return; }
    const c = q.get("c");
    if (c && /\/turbo\/duel\/?$/.test(location.pathname)) location.replace(withBase(`/api/turbo/invite?c=${encodeURIComponent(c)}`));
    // the duel-only demo page (/duel): same friend-link pass, back to /duel
    else if (c && /\/duel\/?$/.test(location.pathname)) location.replace(withBase(`/api/turbo/invite?c=${encodeURIComponent(c)}&to=duel`));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw.trim() || state === "busy") return;
    setState("busy");
    try {
      const r = await fetch(withBase("/api/turbo/pass"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
      if (r.ok) {
        // stay where the pilot was headed (a duel link keeps its ?c= code); plain /turbo opens as the play sample
        const u = new URL(location.href);
        if (/\/turbo\/?$/.test(u.pathname) && !u.searchParams.has("sample")) u.searchParams.set("sample", "1");
        location.replace(u.toString()); return;
      }
      setState(r.status === 429 ? "slow" : "wrong");
    } catch { setState("slow"); }
  };
  return (
    <main className={s.page} data-testid="turbo-gate">
      <form className={s.card} onSubmit={submit}>
        <span className={s.word}>{duelOnly ? "TRADING DUEL" : "TURBO"}</span>
        <p className={s.lead}>{closed ? "That duel link has closed. Ask your friend for a fresh one, or enter the password." : "Early access. Enter the password to play."}</p>
        <input className={s.input} type="password" autoFocus autoComplete="current-password" aria-label="Password" placeholder="Password"
          value={pw} onChange={(e) => { setPw(e.target.value); if (state !== "busy") setState("idle"); }} data-testid="turbo-gate-input" />
        <button className={s.go} type="submit" disabled={!pw.trim() || state === "busy"} data-testid="turbo-gate-go">{state === "busy" ? "Checking…" : "Enter"}</button>
        {state === "wrong" && <p className={s.err} role="alert">That&rsquo;s not it. Try again.</p>}
        {state === "slow" && <p className={s.err} role="alert">Too many tries. Wait a minute and try again.</p>}
      </form>
    </main>
  );
}
