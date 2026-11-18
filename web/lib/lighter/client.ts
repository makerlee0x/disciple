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
