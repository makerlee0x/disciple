/** Chat moderation (App Review 1.2): report → Team queue, 3 reporters hide a message, mute blocks sending, hidden ids drop. */
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.KV_ALLOW_LOCAL = "1";
process.env.KV_LOCAL_FILE = `/tmp/disciple-chatmod-${process.pid}.json`;
const { chatStore } = await import("../lib/server/chat/store.ts");
const { historyOf } = await import("../lib/server/chat/store.ts");
const { reportMessage, listReports, moderate, isMuted, AUTO_HIDE_AT } = await import("../lib/server/chat/moderation.ts");
const { parseHidden } = await import("../lib/server/chat/hidden.ts");

const coin = "0x" + "ab".repeat(20);
const from = { addr: "0x" + "11".repeat(20), name: "spammer" };
const id = "01JD0000000000000000000000";
await chatStore().append(coin, { id, coin, kind: "user", from, text: "buy my scam", ts: 1 });

test("own message can't be reported; unknown id is refused", async () => {
  assert.deepEqual(await reportMessage(coin, id, from.addr, "spam"), { ok: false, status: 400, error: "That's your own message." });
  const r = await reportMessage(coin, "01JD9999999999999999999999", "0x" + "22".repeat(20), "spam");
  assert.equal(r.ok, false);
});

test("reports queue for the Team, one per player, and 3 hide the message", async () => {
  for (let i = 0; i < AUTO_HIDE_AT; i++) {
    const by = "0x" + String(30 + i).repeat(20);
    const r = await reportMessage(coin, id, by, "scam");
    assert.equal(r.ok, true);
    if (i === 0) assert.deepEqual(await reportMessage(coin, id, by, "scam"), { ok: true, hidden: false });   // repeat ignored
  }
  const [g] = await listReports();
  assert.equal(g.id, id); assert.equal(g.reporters, AUTO_HIDE_AT); assert.equal(g.hidden, true); assert.deepEqual(g.reasons, ["scam"]);
  await new Promise((r) => setTimeout(r, 5100));   // hidden-id cache
  assert.equal((await historyOf(coin, 50)).some((m) => m.id === id), false);
});

test("Team restore, mute, unmute, dismiss", async () => {
  assert.equal((await moderate("restore", id)).ok, true);
  assert.equal((await listReports())[0].hidden, false);
  assert.equal((await moderate("mute", id)).ok, true);
  assert.equal(await isMuted(from.addr), true);
  assert.equal((await moderate("unmute", id)).ok, true);
  assert.equal(await isMuted(from.addr), false);
  assert.equal((await moderate("dismiss", id)).ok, true);
  assert.equal((await listReports()).length, 0);
});

test("parseHidden survives junk", () => {
  assert.deepEqual(parseHidden(null), []); assert.deepEqual(parseHidden("{"), []); assert.deepEqual(parseHidden('["a",1]'), ["a"]);
});
