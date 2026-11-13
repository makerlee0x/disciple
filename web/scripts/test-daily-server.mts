/** Daily flight server rules (lib/server/daily.ts): the start ticket, the 2-minute floor, one scored run per device, 5 per IP. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startDaily, submitDaily, runIdOf, ipBucket, netOf, DAILY_PER_IP } from "../lib/server/daily";
import { sameSitePost } from "../lib/server/limits";
import { issueTicket } from "../lib/server/dailySeed";
import { dailyToday } from "../lib/sim/daily";

const id = dailyToday(), ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
const dev = () => randomUUID();
const oldTicket = (device: string, from = ip) => issueTicket(id, runIdOf(device), netOf(from), Date.now() - 125_000);

test("a fresh ticket is refused (the flight ended too fast), no ticket is refused", async () => {
  const d = dev(), st = await startDaily(id, d, ip);
  assert.ok(st.ok && st.ticket && !st.already);
  const fast = await submitDaily(id, d, [], st.ok ? st.ticket : "");
  assert.ok(!fast.ok && fast.status === 403 && /too fast/.test(fast.error));
  const none = await submitDaily(id, d, [], "");
  assert.ok(!none.ok && none.status === 403);
  const other = await submitDaily(id, dev(), [], await oldTicket(d));
  assert.ok(!other.ok && other.status === 403, "another device's ticket");
});

test(`one scored run per device, ${DAILY_PER_IP} per IP, then start and submit are refused`, async () => {
  const devices = Array.from({ length: DAILY_PER_IP }, dev);
  for (const d of devices) { const r = await submitDaily(id, d, [], await oldTicket(d)); assert.ok(r.ok && !r.already, "scored"); }
  const again = await submitDaily(id, devices[0], [], await oldTicket(devices[0]));
  assert.ok(again.ok && again.already, "a second run from the same device returns the first");
  const st = await startDaily(id, dev(), ip);
  assert.ok(!st.ok && st.status === 429, "start refused past the cap");
  const sixth = dev(), sub = await submitDaily(id, sixth, [], await oldTicket(sixth));
  assert.ok(!sub.ok && sub.status === 429, "submit refused past the cap");
  const back = await startDaily(id, devices[1], ip);
  assert.ok(back.ok && back.already, "a device that already flew can still open its result");
});

test("IPv6 counts by its /64, IPv4 by its address", () => {
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), ipBucket("2001:db8:1:2:ffff:1:2:3"));
  assert.notEqual(ipBucket("2001:db8:1:2::1"), ipBucket("2001:db8:1:3::1"));
  assert.equal(ipBucket("2001:0db8:0001:0002::"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(ipBucket("1.2.3.4"), "1.2.3.4");
  assert.notEqual(ipBucket("1.2.3.4"), ipBucket("1.2.3.5"));
});

test("tickets a hostile site issued to itself spend its own quota, not the visitor's", async () => {
  const evil = "10.250.250.1", victim = "10.250.250.2";
  for (let i = 0; i < DAILY_PER_IP; i++) { const d = dev(); const r = await submitDaily(id, d, [], await oldTicket(d, evil)); assert.ok(r.ok); }
  assert.ok((await startDaily(id, dev(), victim)).ok, "the visitor's network can still start");
  const st = await startDaily(id, dev(), evil); assert.ok(!st.ok && st.status === 429, "the issuing network is charged");
});

test("daily POSTs only from our own pages", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.ok(sameSitePost(h({ "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "https://disciple.vip", host: "disciple.vip" })));
  assert.ok(!sameSitePost(h({ "content-type": "text/plain", "sec-fetch-site": "cross-site" })), "simple cross-site POST");
  assert.ok(!sameSitePost(h({ "content-type": "application/json", "sec-fetch-site": "cross-site" })));
  assert.ok(!sameSitePost(h({ "content-type": "application/json", origin: "https://evil.example", host: "disciple.vip" })));
  assert.ok(!sameSitePost(h({ "content-type": "text/plain;charset=UTF-8" })));
});
