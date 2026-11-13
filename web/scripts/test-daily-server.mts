/** Daily flight server rules (lib/server/daily.ts): the start ticket, the 2-minute floor, one scored run per device, 5 per IP. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startDaily, submitDaily, runIdOf, ipBucket, DAILY_PER_IP } from "../lib/server/daily";
import { issueTicket } from "../lib/server/dailySeed";
import { dailyToday } from "../lib/sim/daily";

const id = dailyToday(), ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
const dev = () => randomUUID();
const oldTicket = (device: string) => issueTicket(id, runIdOf(device), Date.now() - 125_000);

test("a fresh ticket is refused (the flight ended too fast), no ticket is refused", async () => {
  const d = dev(), st = await startDaily(id, d, ip);
  assert.ok(st.ok && st.ticket && !st.already);
  const fast = await submitDaily(id, d, [], st.ok ? st.ticket : "", ip);
  assert.ok(!fast.ok && fast.status === 403 && /too fast/.test(fast.error));
  const none = await submitDaily(id, d, [], "", ip);
  assert.ok(!none.ok && none.status === 403);
  const other = await submitDaily(id, dev(), [], await oldTicket(d), ip);
  assert.ok(!other.ok && other.status === 403, "another device's ticket");
});

test(`one scored run per device, ${DAILY_PER_IP} per IP, then start and submit are refused`, async () => {
  const devices = Array.from({ length: DAILY_PER_IP }, dev);
  for (const d of devices) { const r = await submitDaily(id, d, [], await oldTicket(d), ip); assert.ok(r.ok && !r.already, "scored"); }
  const again = await submitDaily(id, devices[0], [], await oldTicket(devices[0]), ip);
  assert.ok(again.ok && again.already, "a second run from the same device returns the first");
  const st = await startDaily(id, dev(), ip);
  assert.ok(!st.ok && st.status === 429, "start refused past the cap");
  const sixth = dev(), sub = await submitDaily(id, sixth, [], await oldTicket(sixth), ip);
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
