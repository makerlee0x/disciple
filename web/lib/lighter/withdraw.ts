/**
 * Turbo cash → Cash, browser side (server: lib/server/lighter/withdraw). The server signs a transfer to Lighter's
 * fast-withdraw pool with Disciple's trading key; the player's wallet signs Lighter's message (silent with the Privy
 * wallet); the server sends the fast withdrawal and Lighter pays the player's cash address.
 */
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function post<T>(f: Fetcher, body: Record<string, unknown>): Promise<T> {
  const r = await f("/api/lighter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string } & T;
  if (!r.ok || !j.ok) throw new Error(j.reason || "Turbo didn't answer.");
  return j;
}

export type WithdrawInfo = { usd: number; fee: number; min: number };
export const lighterWithdrawInfo = (f: Fetcher) => post<WithdrawInfo>(f, { op: "withdraw-info" });

/** Moves `usd` of Turbo cash to `to` (the player's cash address). Resolves once Lighter took the withdrawal. */
export async function lighterWithdraw(f: Fetcher, usd: number, to: string, signMessage: (msg: string) => Promise<string>): Promise<{ usd: number }> {
  const { message } = await post<{ message: string; usd: number; fee: number }>(f, { op: "withdraw-start", usd, to });
  const sig = await signMessage(message);
  return post<{ usd: number }>(f, { op: "withdraw-finish", sig });
}
