/**
 * Client trade latency marks (console only, never shown to players): click → send → response → fill (keys aligned with GAME's 'disciple:op' "filled" ms: quote/submit/confirm/fill/total; no new event).
 * Uses performance.mark/measure so the stages also show in the browser Performance panel.
 *  - markTradeClick(): call from the click/key handler (TradeBridge, GAME) — the trade picks up the latest click ≤ 3 s old;
 *    without it the clock starts when the protocol trade starts.
 *  - startTradeTiming(): one per trade (lib/protocol-viem); stages are marked by lib/aa/mav2 (send, response) and the
 *    trade itself (fill). done() logs `[disciple] trade timing` with per-stage ms + the server's relay stages.
 * Read it live: filter the console by "[disciple] trade timing".
 */
const P = "disciple:trade";
const perf = () => (typeof performance !== "undefined" && typeof performance.mark === "function" ? performance : null);
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
let lastClick: number | undefined;
let seq = 0;

export function markTradeClick() {
  lastClick = nowMs();
  try { perf()?.mark(`${P}:click`); } catch { /* old browsers */ }
}

export type TradeTiming = {
  readonly id: number;
  /** Mark a stage (first mark per stage wins: a retried send keeps its first "send"). */
  mark(stage: string): void;
  /** Extra fields for the log line (e.g. server stages, fast/standard path). */
  note(extra: Record<string, unknown>): void;
  /** Log once: `[disciple] trade timing` { label, click→fill ms, per-stage deltas, …notes }. */
  /** "pending": the press went pending_unknown (AUDIT) — its fill, if any, is booked later by the watcher. */
  done(outcome: "fill" | "error" | "pending", extra?: Record<string, unknown>): Record<string, unknown> | undefined;
};

export function startTradeTiming(label: string, clock: () => number = nowMs, log: (o: Record<string, unknown>) => void = defaultLog): TradeTiming {
  const id = ++seq;
  const t0 = clock();
  const click = lastClick !== undefined && t0 - lastClick <= 3000 && t0 >= lastClick ? lastClick : t0;
  lastClick = undefined;   // one click ↔ one trade
  const at: Record<string, number> = { click };
  const notes: Record<string, unknown> = {};
  let logged = false;
  const p = perf();
  const name = (s: string) => `${P}:${id}:${s}`;
  try { p?.mark(name("start")); } catch { /* */ }
  return {
    id,
    mark(stage) {
      if (at[stage] !== undefined) return;
      at[stage] = clock();
      try { p?.mark(name(stage)); } catch { /* */ }
    },
    note(extra) { Object.assign(notes, extra); },
    done(outcome, extra) {
      if (logged) return undefined;
      logged = true;
      const end = clock();
      at[outcome] = end;
      // Same keys as GAME's 'disciple:op' phase 'filled' ms:{quote,submit,confirm,fill,total} (#138), plus the server split.
      // quote = click → op sent (quote + build + sign); submit/confirm = the relay round trip, split by the relay's own
      // "mined" wait (block inclusion) when it reports one; fill = response → trade returned.
      const srv = (notes.server ?? {}) as Record<string, number>;
      const rt = at.send !== undefined && at.response !== undefined ? at.response - at.send : undefined;
      const mined = typeof srv.mined === "number" ? srv.mined : undefined;
      const ms: Record<string, number> = { total: Math.round(end - click) };
      if (at.send !== undefined) ms.quote = Math.round(at.send - click);
      if (rt !== undefined) { ms.confirm = Math.round(mined !== undefined ? Math.min(mined, rt) : 0); ms.submit = Math.round(rt - ms.confirm); }
      if (at.response !== undefined) ms.fill = Math.round(end - at.response);
      const row = { label, outcome, ms, preStart: Math.round(t0 - click), ...notes, ...(extra ?? {}) };
      try { p?.measure(`${P}:${id}:total`, { start: click, end } as PerformanceMeasureOptions); } catch { /* */ }
      try { for (const s of ["start", "send", "response"]) p?.clearMarks(name(s)); } catch { /* */ }
      log(row);
      return row;
    },
  };
}

function defaultLog(o: Record<string, unknown>) {
  if (typeof console !== "undefined") console.info("[disciple] trade timing", o);
}
