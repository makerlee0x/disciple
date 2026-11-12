// Initial render must include real-holder loading UI even before chat connects.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CARD_IDS, CARD_TITLES, parseLayout } from "../lib/game/cardLayout";
// tsx's standalone JSX transform uses React; Next supplies its own automatic JSX runtime.
Object.assign(globalThis, { React });
const { default: GameChat } = await import("../components/gamechat/GameChat");
const source = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("one visible Holders | Chat card before chat API is ready, with no Chat opener", () => {
  const html = renderToStaticMarkup(React.createElement(GameChat, { coin: `0x${"11".repeat(20)}` }));
  assert.equal((html.match(/data-testid="chat-dock"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Holders and chat"/);
  assert.match(html, /aria-selected="true"[^>]*data-testid="chat-tab-holders"/);
  assert.match(html, /data-testid="chat-tab-chat"/);
  assert.ok(html.indexOf('chat-tab-holders') < html.indexOf('chat-tab-chat'));
  assert.doesNotMatch(html, /data-testid="chat-open"/);
  assert.match(html, /data-testid="holders-/);
  assert.equal(CARD_TITLES.chat, "Holders", "layout restore/overflow is Holders, never a Chat pill");
});

test("Chat is only inside the combined card on phones too", () => {
  const hud = source("components/flight/PhoneHud.tsx");
  assert.doesNotMatch(hud, /\{ id: "chat", label:/);
  assert.match(hud, /data-ph-sheet="holders"\] \[data-testid="chat-dock"\]/);
  assert.doesNotMatch(source("components/gamechat/GameChat.tsx"), /data-testid="chat-open"|chatPillPlace|disciple\.gamechat\.open/);
});

test("removed display-only control box is not restorable, while keyboard handlers remain", () => {
  const engine = source("public/flight/engine.js");
  assert.doesNotMatch(engine, /cardBegin\('controls'|SPACE turbo|ZXCV sell|BUY \$\{fmtShot\(md\.usd\)\}\/shot/);
  assert.match(engine, /if \(S\.controlsDocked\) pushControls\(\);/);
  assert.match(engine, /function onHotkey\(/);
  assert.ok(!CARD_IDS.includes("controls" as never));
  assert.deepEqual(parseLayout(JSON.stringify({ controls: { min: true } })), {});
});
