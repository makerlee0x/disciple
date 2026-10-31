// PR #221 snap-to-grid: cards dropped anywhere (any slot / order, any subset, migrated x/y) never overlap each other, the
// wallet strip, the BUY/SELL panel or the BOOST/DUMP bar, and stay inside the content area — sidebar 64 / 220 / 270, 1280–1920.
import { computeSlots, flowCards, hit, nearestSlot, SLOT_IDS, type Box, type FlowCard, type SlotEnv } from "../lib/game/slots";
let bad = 0, n = 0, hidden = 0; const ok = (c: boolean, m: string) => { if (!c) { if (bad < 15) console.log("FAIL " + m); bad++; } };
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const sizes: Record<string, [number, number]> = { header: [380, 176], pnl: [216, 105], chart: [440, 280], trades: [310, 140], holders: [310, 96], controls: [310, 84] };
for (const [vw, vh] of [[1280, 800], [1366, 768], [1440, 900], [1680, 1050], [1920, 1080]]) for (const side of [64, 220, 248, 270]) for (const signedIn of [0, 1, 3]) {
  const L = side, W = vw - L, wallet: Box = signedIn ? { x: vw - 16 - 430, y: 10, w: 430, h: signedIn === 3 ? 122 : 48 } : { x: vw - 85, y: 10, w: 69, h: 27 };
  const ammo: Box = { x: L + Math.max(410, Math.min((W - 472) / 2, W - 330 - 14 - 472)), y: 18, w: 472, h: 108 };
  if (ammo.x + ammo.w > wallet.x - 8) ammo.y = wallet.y + wallet.h + 14;
  const colTop = ammo.x + ammo.w > vw - 330 - 14 ? ammo.y + ammo.h + 10 : wallet.y + wallet.h + 18;
  const bar: Box = { x: L + Math.round((W - 544) / 2), y: vh - 134, w: 544, h: 120 };   // trade bar + tramp/wall buttons
  const env: SlotEnv = { vw, vh, left: L, colTop, wallet, bar, ammo };
  const fixed = [wallet, bar, ammo];
  const base = (id: string): Box => { const [w, h] = sizes[id];
    return id === "header" ? { x: L + 20, y: 18, w, h } : id === "pnl" ? { x: L + 20, y: 200, w, h } : id === "chart" ? { x: L + 20, y: 315, w, h }
      : id === "trades" ? { x: L + 20, y: vh - 160, w, h } : id === "holders" ? { x: vw - 330, y: colTop, w, h } : { x: vw - 330, y: vh - 104, w, h }; };
  const ids = Object.keys(sizes);
  for (let trial = 0; trial < 60; trial++) {
    const cards: FlowCard[] = ids.filter(() => rnd() < 0.85).map((id) => {
      const r = rnd(), b = base(id);
      if (trial === 0 || r < 0.25) return { id, base: b };                                         // never moved
      if (r < 0.5) { const s = computeSlots(env), dx = rnd() * vw, dy = rnd() * vh;                 // migrated old x/y
        return { id, base: b, slot: nearestSlot(s, dx, dy), order: dy }; }
      return { id, base: b, slot: SLOT_IDS[Math.floor(rnd() * 5)], order: Math.floor(rnd() * vh) }; // dropped in a slot
    });
    const out = flowCards(env, cards, fixed), rects = cards.filter((c) => !out[c.id].overflow).map((c) => ({ id: c.id, x: out[c.id].x, y: out[c.id].y, w: c.base.w, h: c.base.h }));
    const tag = `${vw}x${vh} side ${side} ${signedIn ? `wallet ${signedIn} row(s)` : "guest"} trial ${trial}`;
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      ok(a.x >= L && a.y >= 0 && a.x + a.w <= vw && a.y + a.h <= vh, `${tag}: ${a.id} off content ${JSON.stringify(a)}`);
      for (const f of fixed) ok(!hit(a, f), `${tag}: ${a.id} × fixed ${JSON.stringify(a)} ${JSON.stringify(f)}`);
      for (let j = i + 1; j < rects.length; j++) ok(!hit(a, rects[j]), `${tag}: ${a.id} × ${rects[j].id} ${JSON.stringify(a)} ${JSON.stringify(rects[j])}`);
    }
    hidden += cards.length - rects.length; n++;
  }
}
// the default layout is kept when it is clear (wide screen, nothing moved)
{ const env: SlotEnv = { vw: 1920, vh: 1080, left: 64, colTop: 55, wallet: { x: 1835, y: 10, w: 69, h: 27 }, bar: { x: 720, y: 946, w: 544, h: 120 }, ammo: { x: 756, y: 18, w: 472, h: 108 } };
  const out = flowCards(env, [{ id: "header", base: { x: 84, y: 18, w: 380, h: 176 } }, { id: "trades", base: { x: 84, y: 920, w: 310, h: 140 } }], []);
  ok(out.header.x === 84 && out.header.y === 18 && out.trades.y === 920 && !out.trades.slot, "wide screen: defaults untouched " + JSON.stringify(out)); }
// a default spot that hits the bar (1280 sidebar open: TRADES under BOOST/DUMP) gets flowed clear of it
{ const env: SlotEnv = { vw: 1280, vh: 800, left: 270, colTop: 136, wallet: { x: 1195, y: 10, w: 69, h: 27 }, bar: { x: 503, y: 666, w: 544, h: 121 }, ammo: { x: 680, y: 18, w: 472, h: 108 } };
  const out = flowCards(env, [{ id: "trades", base: { x: 290, y: 640, w: 310, h: 140 } }], [env.wallet!, env.bar!, env.ammo!]);
  ok(!hit({ ...out.trades, w: 310, h: 140 }, env.bar!), "trades cleared off the bar " + JSON.stringify(out)); }
// slots never use a hard-coded sidebar width: they start at the measured left edge
ok(computeSlots({ vw: 1280, vh: 800, left: 220 }).tl.x === 240 && computeSlots({ vw: 1280, vh: 800, left: 270 }).tl.x === 290, "slots follow the content left edge");
console.log(bad ? `FAIL · ${bad}` : `ok · ${n} drop scenarios, no overlaps (${hidden} cards had no room anywhere → hidden)`); process.exit(bad ? 1 : 0);
