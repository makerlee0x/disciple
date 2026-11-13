"use client";
/** Password screen in front of /turbo while it's pre-launch. On the right password the server sets a cookie and the page
 *  reloads as the play sample (live prices, sample fuel). */
import { useState } from "react";
import { withBase } from "@/lib/base-path";
import s from "./gate.module.css";

export default function TurboGate() {
  const [pw, setPw] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "wrong" | "slow">("idle");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw.trim() || state === "busy") return;
    setState("busy");
    try {
      const r = await fetch(withBase("/api/turbo/pass"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
      if (r.ok) { location.replace(withBase("/turbo?sample=1")); return; }
      setState(r.status === 429 ? "slow" : "wrong");
    } catch { setState("slow"); }
  };
  return (
    <main className={s.page} data-testid="turbo-gate">
      <form className={s.card} onSubmit={submit}>
        <span className={s.word}>TURBO</span>
        <p className={s.lead}>Early access. Enter the password to play.</p>
        <input className={s.input} type="password" autoFocus autoComplete="current-password" aria-label="Password" placeholder="Password"
          value={pw} onChange={(e) => { setPw(e.target.value); if (state !== "busy") setState("idle"); }} data-testid="turbo-gate-input" />
        <button className={s.go} type="submit" disabled={!pw.trim() || state === "busy"} data-testid="turbo-gate-go">{state === "busy" ? "Checking…" : "Enter"}</button>
        {state === "wrong" && <p className={s.err} role="alert">That&rsquo;s not it. Try again.</p>}
        {state === "slow" && <p className={s.err} role="alert">Too many tries. Wait a minute and try again.</p>}
      </form>
    </main>
  );
}
