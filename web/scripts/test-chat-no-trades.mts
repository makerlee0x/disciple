// Trades are not chat (lee 2026-10-26 test 2): stored buy / sell / nuke event lines are hidden from history and the
// live stream; user messages and graduation lines still show.
//   pnpm test:chat-no-trades   (in-memory chat store, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMsg } from "../lib/chat/types";

delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
const { chatStore, historyOf, messagesAfter, isTradeLine } = await import("../lib/server/chat/store");

const coin = "0x" + "a".repeat(40);
const msg = (id: string, kind: ChatMsg["kind"], event?: string): ChatMsg =>
  ({ id, coin, kind, from: null, text: id, ts: 0, ...(event ? { meta: { event } } : {}) });

test("isTradeLine: buy / sell / nuke events only", () => {
  assert.equal(isTradeLine(msg("1", "event", "buy")), true);
  assert.equal(isTradeLine(msg("2", "event", "sell")), true);
  assert.equal(isTradeLine(msg("3", "event", "nuke")), true);
  assert.equal(isTradeLine(msg("4", "event", "graduate")), false);
  assert.equal(isTradeLine(msg("5", "user")), false);
  assert.equal(isTradeLine(msg("6", "system")), false);
});

test("history and the live stream drop stored trade lines", async () => {
  const st = chatStore();
  for (const m of [msg("01", "user"), msg("02", "event", "buy"), msg("03", "event", "sell"), msg("04", "event", "graduate"), msg("05", "user")]) await st.append(coin, m);
  assert.deepEqual((await historyOf(coin, 50)).map((m) => m.id), ["01", "04", "05"]);
  assert.deepEqual((await messagesAfter(coin, "01")).map((m) => m.id), ["04", "05"]);
});
