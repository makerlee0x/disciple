// game/hud-sidebar-layout: CHAT pill never sits on the bottom trade bar, any width (sidebar 64/220/270, 1280–1920).
import { chatPillPlace } from "../lib/gamechat/pillPlace";
let bad = 0, n = 0; const ok = (c: boolean, m: string) => { if (!c) { console.log("FAIL " + m); bad++; } };
for (const vw of [1280, 1366, 1440, 1536, 1680, 1920]) for (const side of [64, 220, 248, 270]) for (const vh of [800, 900, 1080]) {
  const W = vw - side, bw = 434, bar = { x: side + Math.round((W - bw) / 2), y: vh - 64, w: bw, h: 52 };
  const tw = { x: side + Math.round(W / 2) - 140, y: vh - 126, w: 276, h: 30 };
  const p = chatPillPlace(vw, vh, 110, 30, [bar, tw]), px = vw - p.right - 110, py = vh - p.bottom - 30;
  const hit = px < bar.x + bar.w && bar.x < px + 110 && py < bar.y + bar.h && bar.y < py + 30;
  const hitTw = px < tw.x + tw.w && tw.x < px + 110 && py < tw.y + tw.h && tw.y < py + 30;
  ok(!hit && !hitTw && px >= side && px + 110 <= vw - 20 && py >= 0, `vw ${vw} side ${side} vh ${vh}: ${JSON.stringify(p)}`); n++;
}
ok(JSON.stringify(chatPillPlace(1920, 1080, 110, 30, [])) === '{"right":344,"bottom":20}', "no bar → default");
console.log(bad ? `FAIL · ${bad}` : `ok · ${n} placements`); process.exit(bad ? 1 : 0);
