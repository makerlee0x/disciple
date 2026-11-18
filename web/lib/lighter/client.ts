/**
 * Browser side of Lighter set-up and orders (/api/lighter). `signMessage` is the player's wallet personal_sign
 * (Privy embedded wallet), used twice ever: to register Disciple's trading key, and to approve the partner fee.
 */
export type LighterStep = "deposit" | "key" | "tier" | "approve" | "ready";
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function call<T>(f: Fetcher, init?: { op: string } & Record<string, unknown>): Promise<T> {
  const r = await f("/api/lighter", init ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init) } : undefined);
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string } & T;
  if (!r.ok || !j.ok) throw new Error(j.reason || "Lighter didn't answer.");
  return j;
}

export const lighterStatus = (f: Fetcher) => call<{ step: LighterStep; network: string; account: number | null; feeBp: number }>(f);

/** Runs every set-up step that's left. Stops at "deposit" (the player has to add cash to Lighter first). */
export async function lighterSetUp(f: Fetcher, signMessage: (msg: string) => Promise<string>): Promise<LighterStep> {
  for (let i = 0; i < 4; i++) {
    const { step } = await lighterStatus(f);
    if (step === "ready" || step === "deposit") return step;
    if (step === "tier") { await call(f, { op: "tier" }); continue; }
    const kind = step === "key" ? "key" : "approve";
    const { message } = await call<{ message: string }>(f, { op: `${kind}-start` });
    await call(f, { op: `${kind}-finish`, sig: await signMessage(message) });
  }
  return (await lighterStatus(f)).step;
}

export const lighterOpen = (f: Fetcher, market: string, side: "long" | "short", usd: number) =>
  call<{ hash: string; base: number; price: number; fill: number; lev: number; ms: Record<string, number> }>(f, { op: "open", market, side, usd });
export const lighterClose = (f: Fetcher, market: string) => call<{ hash: string; price: number; ms: Record<string, number> }>(f, { op: "close", market });
/** Loads the player into the server ahead of a duel so the first tap is warm. */
export const lighterWarm = (f: Fetcher) => call(f, { op: "warm" });

/**
 * Pre-signed taps. The server signs the next long, short and close ahead of time (one nonce, so only one can land, with a
 * short expiry and a price cap); this holds the latest set and a tap posts the chosen order straight to Lighter. If the
 * browser can't reach Lighter (network or CORS), the same signed order goes through /api/lighter instead.
 */
export type TapKind = "long" | "short" | "close";
type Signed = { txType: number; txInfo: string; cap: number; base: number };
export type LighterTicket = { url: string; nonce: number; exp: number; market: number; lev: number; mid: number; long: Signed; short: Signed; close?: Signed & { side: "long" | "short" }; ms?: Record<string, number> };
export type TapResult = { hash: string; ms: number; via: "direct" | "relay"; waited: boolean; nonce: number; cap: number; base: number };

const REFRESH_MS = 5_000;
const SAFETY_MS = 2_000; // don't send a set this close to its expiry

export class LighterTaps {
  ticket: LighterTicket | null = null;
  lastError: string | null = null;
  private loading: Promise<LighterTicket | null> | null = null;
  private floor = 0;
  private tapping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(t: LighterTicket | null) => void>();
  private direct = true;
  private gen = 0;

  constructor(private f: Fetcher, public market: string, public usd: number) {}

  onTicket(fn: (t: LighterTicket | null) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach((fn) => fn(this.ticket)); }

  start() {
    this.stop();
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.tapping) void this.refresh();
      // keeps the browser's connection to Lighter open so a tap skips the TLS handshake
      if (this.ticket && this.direct) void fetch(`${this.ticket.url}/api/v1/status`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
    }, REFRESH_MS);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  set(market: string, usd: number) { if (market === this.market && usd === this.usd) return; this.market = market; this.usd = usd; this.ticket = null; this.loading = null; this.emit(); void this.refresh(); }

  refresh(used?: { nonce: number; kind: TapKind }): Promise<LighterTicket | null> {
    if (this.loading && !used) return this.loading;
    const g = ++this.gen; // only the newest answer counts; an older one may carry a spent nonce
    const p = call<LighterTicket>(this.f, { op: "presign", market: this.market, usd: this.usd, used, floor: this.floor })
      .then((t) => { if (g !== this.gen) return this.ticket; this.ticket = t; this.lastError = null; this.emit(); return t; })
      .catch((e: Error) => { if (g !== this.gen) return this.ticket; this.lastError = e.message; this.ticket = null; this.emit(); return null; })
      .finally(() => { if (this.loading === p) this.loading = null; });
    this.loading = p;
    return p;
  }

  /** Sends the tapped order. `ms` is tap → Lighter's answer, as the browser saw it. */
  async tap(kind: TapKind): Promise<TapResult> {
    if (this.tapping) throw new Error("One at a time.");
    this.tapping = true;
    const t0 = performance.now();
    try {
      let t = this.ticket, waited = false;
      if (!t || t.exp - SAFETY_MS < Date.now()) { waited = true; t = await this.refresh(); }
      if (!t) throw new Error(this.lastError ?? "Lighter didn't answer.");
      const o = t[kind];
      if (!o) throw new Error("Nothing open.");
      this.ticket = null; this.emit(); // spent: every order in the set shares its nonce
      let hash: string, via: TapResult["via"] = "direct";
      try {
        hash = await this.send(t.url, o);
      } catch (e) {
        if ((e as Error).name === "LighterRejected") { this.floor = t.nonce; void this.refresh(); throw e; }
        // couldn't reach Lighter from here: same signed order through the server (a duplicate can't land, same nonce)
        via = "relay"; this.direct = false;
        try { hash = (await call<{ hash: string }>(this.f, { op: "relay", txType: o.txType, txInfo: o.txInfo })).hash; }
        catch (e2) {
          // a nonce clash here means the direct send did land (the browser just couldn't read Lighter's answer)
          if (!/nonce/i.test((e2 as Error).message)) { this.floor = t.nonce; void this.refresh(); throw e2; }
          hash = "";
        }
      }
      const ms = Math.round(performance.now() - t0);
      this.floor = t.nonce + 1;
      void this.refresh({ nonce: t.nonce, kind });
      return { hash, ms, via, waited, nonce: t.nonce, cap: o.cap, base: o.base };
    } finally { this.tapping = false; }
  }

  private async send(url: string, o: Signed): Promise<string> {
    if (!this.direct) throw new TypeError("direct off");
    // form body keeps this a "simple" CORS request: no preflight round trip
    const r = await fetch(`${url}/api/v1/sendTx`, { method: "POST", body: new URLSearchParams({ tx_type: String(o.txType), tx_info: o.txInfo }), cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string; tx_hash?: string };
    if (!r.ok || (j.code !== undefined && j.code !== 200) || !j.tx_hash) {
      const e = new Error(j.message || `Lighter ${r.status}`); e.name = "LighterRejected"; throw e;
    }
    return j.tx_hash;
  }
}
