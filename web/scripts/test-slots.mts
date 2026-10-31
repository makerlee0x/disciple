// PR #221 snap-to-grid + clear lane + chart cap + tabs + overlay mode. Cards dropped anywhere (any slot / order / subset,
// migrated x/y) never overlap each other, the wallet strip (1 or 3 rows), the BUY/SELL panel, the BOOST/DUMP bar or the
// centre lane; stay inside the usable area; the chart stays within its cap; a card with no room is a TAB (never hidden).
// Sidebar push 64 / 220 / 248 / 270 and overlay mode (canvas full width, left 248 blocked while open), 1280–1920.
import { centerLane, chartCap, COMPACT_W, computeSlots, hit, layoutCards, nearestSlot, SLOT_IDS, type Box, type FlowCard, type SlotEnv } from "../lib/game/slots";
let bad = 0, n = 0, tabs = 0, folded = 0; const ok = (c: boolean, m: string) => { if (!c) { if (bad < 15) console.log("FAIL " + m); bad++; } };
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const modes: [string, number, boolean][] = [["push", 64, false], ["push", 220, false], ["push", 248, false], ["push", 270, false], ["overlay", 248, true], ["overlay-closed", 0, true]];
for (const [vw, vh] of [[1280, 800], [1366, 768], [1440, 900], [1680, 1050], [1920, 1080]]) for (const [mode, side, overlay] of modes) for (const rows of [0, 1, 3]) {
  const canvasL = overlay ? 0 : side, canvasW = vw - canvasL, L = overlay ? side : side;
  const wallet: Box = rows ? { x: vw - 16 - 430, y: 10, w: 430, h: rows === 3 ? 122 : 48 } : { x: vw - 85, y: 10, w: 69, h: 27 };
  const W = vw - L, ammo: Box = { x: L + Math.max(410, Math.min((W - 472) / 2, W - 330 - 14 - 472)), y: 18, w: 472, h: 108 };
  if (ammo.x + ammo.w > wallet.x - 8) ammo.y = wallet.y + wallet.h + 14;
  const colTop = ammo.x + ammo.w > vw - 330 - 14 ? ammo.y + ammo.h + 10 : wallet.y + wallet.h + 18;
  const bar: Box = { x: canvasL + Math.round((canvasW - 544) / 2), y: vh - 134, w: 544, h: 120 };
  const lane = centerLane(canvasL, canvasW, L, vh);
  const env: SlotEnv = { vw, vh, left: L, colTop, wallet, bar, ammo, canvasL, canvasW, lane };
  const fixed = [wallet, bar, ammo], compact = vw - L < COMPACT_W;
  const cap = chartCap(canvasW, vh, L + 20, lane, vw);
  const sizes: Record<string, [number, number]> = { header: [380, 176], pnl: [216, 105], chart: [cap.w, cap.h], trades: [310, 140], holders: [310, 96], controls: [310, 84], chat: [300, 420] };
  const base = (id: string): Box => { const [w, h] = sizes[id];
    return id === "header" ? { x: L + 20, y: 18, w, h } : id === "pnl" ? { x: L + 20, y: 200, w, h } : id === "chart" ? { x: L + 20, y: 315, w, h }
      : id === "trades" ? { x: L + 20, y: vh - 160, w, h } : id === "holders" ? { x: vw - 330, y: colTop, w, h } : id === "chat" ? { x: vw - 320, y: colTop + 110, w, h } : { x: vw - 330, y: vh - 104, w, h }; };
  const tag0 = `${vw}x${vh} ${mode} ${side} wallet ${rows}r`;
  ok(lane.w >= 180 && lane.x + lane.w / 2 === canvasL + canvasW / 2 || Math.abs(lane.x + lane.w / 2 - (canvasL + canvasW / 2)) <= 1, `${tag0}: lane centred on the rocket ${JSON.stringify(lane)}`);
  ok(cap.w <= Math.max(260, Math.round(canvasW * 0.34)) && cap.h <= Math.max(180, Math.round(vh * 0.45)) && L + 20 + cap.w <= lane.x, `${tag0}: chart cap ${JSON.stringify(cap)}`);
  for (let trial = 0; trial < 40; trial++) {
    const cards: FlowCard[] = Object.keys(sizes).filter(() => trial === 0 || rnd() < 0.85).map((id) => {
      const r = rnd(), b = base(id);
      if (trial === 0 || r < 0.25) return { id, base: b };
      if (r < 0.5) { const s = computeSlots(env), dx = rnd() * vw, dy = rnd() * vh; return { id, base: b, slot: nearestSlot(s, dx, dy), order: dy }; }
      return { id, base: b, slot: SLOT_IDS[Math.floor(rnd() * 5)], order: Math.floor(rnd() * vh) };
    });
    const res = layoutCards(env, cards, fixed, { compact }), tag = `${tag0} trial ${trial}`;
    const shown = cards.filter((c) => !res.pos[c.id].tab).map((c) => ({ id: c.id, x: res.pos[c.id].x, y: res.pos[c.id].y, w: c.base.w, h: c.base.h }));
    ok(shown.length + res.tabs.length === cards.length, `${tag}: every card is shown or a tab (none hidden)`);
    if (compact) ok(["holders", "trades"].every((id) => !cards.some((c) => c.id === id) || res.tabs.includes(id)), `${tag}: secondary cards folded into tabs`);
    if (res.tabs.length) ok(!!res.tabRow && !hit(res.tabRow!, lane) && !fixed.some((f) => hit(res.tabRow!, f)) && res.tabRow!.x >= L, `${tag}: tab row clear ${JSON.stringify(res.tabRow)}`);
    const all = res.tabRow ? [...shown, { id: "tab-row", ...res.tabRow }] : shown;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      ok(a.x >= L && a.y >= 0 && a.x + a.w <= vw && a.y + a.h <= vh, `${tag}: ${a.id} off the usable area ${JSON.stringify(a)}`);
      ok(!hit(a, lane), `${tag}: ${a.id} in the centre lane ${JSON.stringify(a)} lane ${JSON.stringify(lane)}`);
      for (const f of fixed) ok(!hit(a, f), `${tag}: ${a.id} × fixed ${JSON.stringify(a)} ${JSON.stringify(f)}`);
      for (let j = i + 1; j < all.length; j++) ok(!hit(a, all[j]), `${tag}: ${a.id} × ${all[j].id} ${JSON.stringify(a)} ${JSON.stringify(all[j])}`);
    }
    tabs += res.tabs.length; folded += compact ? 1 : 0; n++;
  }
}
// pinned (player opened it on a small screen) → shown, not a tab
{ const env: SlotEnv = { vw: 1280, vh: 800, left: 270, colTop: 136, canvasL: 270, canvasW: 1010, lane: centerLane(270, 1010, 270, 800) };
  const r = layoutCards(env, [{ id: "holders", base: { x: 950, y: 136, w: 310, h: 96 } }], [], { compact: true, pinned: ["holders"] });
  ok(!r.tabs.length && !r.pos.holders.tab, "pinned secondary card stays open " + JSON.stringify(r)); }
// the default layout is kept when it is clear (wide screen, nothing moved)
{ const env: SlotEnv = { vw: 1920, vh: 1080, left: 64, colTop: 55, canvasL: 64, canvasW: 1856, lane: centerLane(64, 1856, 64, 1080) };
  const r = layoutCards(env, [{ id: "header", base: { x: 84, y: 18, w: 380, h: 176 } }, { id: "trades", base: { x: 84, y: 920, w: 310, h: 140 } }], []);
  ok(r.pos.header.x === 84 && r.pos.header.y === 18 && r.pos.trades.y === 920 && !r.tabs.length, "wide screen: defaults untouched " + JSON.stringify(r.pos));
  ok(Math.abs(env.lane!.w / 1856 - 0.32) < 0.01, "wide screen lane ≈ 32% of the canvas " + env.lane!.w); }
ok(computeSlots({ vw: 1280, vh: 800, left: 220 }).tl.x === 240 && computeSlots({ vw: 1280, vh: 800, left: 270 }).tl.x === 290, "slots follow the usable left edge");
console.log(bad ? `FAIL · ${bad}` : `ok · ${n} drop scenarios: no overlaps, nothing in the centre lane, chart within its cap, 0 hidden (${tabs} tabs)`); process.exit(bad ? 1 : 0);
