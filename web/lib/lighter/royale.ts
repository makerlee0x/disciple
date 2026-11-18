/**
 * Turbo Royale on Lighter (hidden, `?lighter=1`). The game (public/turbo/royale/play.html, an iframe) posts your presses
 * as {type: "disciple:royale", op, ...}; this turns them into real orders on your own Lighter account through the same
 * pre-signed WebSocket path as the duel (LighterMatch). One coin at a time: the map you're on. A jump closes the old
 * map's position in the game first, so the order for it goes out before the new coin's set is signed.
 *
 *   start {id, ms, markets}   arms the server buzzer for the whole match (all four coins)
 *   guns  {mk, sizes}         the Lighter margin of each hotbar gun on that coin (re-signs when it changes)
 *   boost / dump {mk, i}      fires gun slot i
 *   close {mk}                cash out, a NUKE, a storm cut or knocked out
 *   end                       closes anything left and stops
 */
import { LighterMatch, lighterFetcher, type MatchAction } from "./duel";

type Msg = { op?: string; id?: string; ms?: number; markets?: string[]; mk?: string; i?: number; sizes?: number[] };
const COINS = new Set(["HYPE", "SOL", "ETH", "BTC"]);

export class RoyaleLighter {
  private f: ReturnType<typeof lighterFetcher> | null = null;
  private ok: Promise<boolean> = Promise.resolve(false);
  private lx: LighterMatch | null = null;
  private mk: string | null = null;
  private sizes: number[] = [];
  private resign: ReturnType<typeof setTimeout> | null = null;
  private quiet = new Set<string>();

  constructor(private wallet: () => string | null, private say: (t: string) => void) {}

  handle(d: Msg) {
    switch (d.op) {
      case "start": return void this.start(d);
      case "guns": return void this.guns(d);
      case "boost": case "dump": return void this.press(d.op, d.i ?? 0);
      case "close": return void this.press("close", 0);
      case "end": return void this.end();
    }
  }

  private async start(d: Msg) {
    await this.end();
    this.quiet.clear();
    const w = this.wallet();
    if (!w) { this.say("Sign in to fly on Lighter."); return; }
    const f = this.f = lighterFetcher(w);
    this.ok = LighterMatch.ready(f).then((r) => { if (!r) this.say("Lighter isn't set up for this wallet. Finish set-up on /lighter."); return r; });
    if (!(await this.ok) || typeof d.id !== "string") return;
    const markets = (d.markets ?? []).filter((m) => COINS.has(m));
    const ms = Math.max(5_000, Math.min(270_000, Number(d.ms) || 240_000));
    void f("/api/lighter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "arm", kind: "royale", id: d.id, ms, markets }) }).catch(() => {});
  }

  private async guns(d: Msg) {
    if (!d.mk || !COINS.has(d.mk) || !Array.isArray(d.sizes)) return;
    this.sizes = d.sizes.slice(0, 6).map((u) => (Number.isFinite(u) && u > 0 ? u : 0));
    if (!(await this.ok) || !this.f) return;
    if (d.mk !== this.mk || !this.lx) {
      const old = this.lx; this.mk = d.mk;
      this.lx = new LighterMatch(this.f, d.mk, () => this.sizes, 0);
      this.lx.start();
      old?.stop();
      return;
    }
    // a press already signs the next set for the sizes after it; this only catches pickups, swaps and ammo running out
    if (this.resign) clearTimeout(this.resign);
    this.resign = setTimeout(() => { this.resign = null; this.lx?.fuel(0); }, 400);
  }

  private async press(action: MatchAction, i: number) {
    if (!(await this.ok) || !this.lx) return;
    const r = await this.lx.press(action, i, 0);
    if ("error" in r) {
      const small = /minimum/i.test(r.error), nothing = action === "close" && /Nothing open/i.test(r.error);
      if (nothing) return;
      if (small) { if (this.quiet.has(this.mk ?? "")) return; this.quiet.add(this.mk ?? ""); }
      this.say(r.error);
    }
  }

  async end() {
    if (this.resign) { clearTimeout(this.resign); this.resign = null; }
    const lx = this.lx; this.lx = null; this.mk = null;
    if (lx) { await lx.closeAll().catch(() => {}); lx.stop(); }
  }
}
