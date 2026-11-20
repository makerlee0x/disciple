/** Turbo cash history, browser side (server: lib/server/lighter/history). The Turbo pill popup's Advanced tab. */
import type { History } from "@/lib/server/lighter/history";
export type { History, HistoryItem } from "@/lib/server/lighter/history";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function lighterHistory(f: Fetcher): Promise<History> {
  const r = await f("/api/lighter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "history" }) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string } & Partial<History>;
  if (!r.ok || !j.ok) throw new Error(j.reason || "Turbo didn't answer.");
  return { account: j.account ?? null, items: j.items ?? [], missing: j.missing ?? [] };
}
