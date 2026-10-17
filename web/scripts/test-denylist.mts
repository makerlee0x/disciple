// Unit tests for the image denylist (lib/server/denylist): stored in the shared Upstash KV (exact sha256 + phash near
// match), in-memory only without KV env, never the filesystem.
//   pnpm test:denylist   (pure: Upstash REST is emulated in-process, no network, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";

// Emulated Upstash REST (GET / SET NX / SADD / SMEMBERS) behind a fake URL; set before lib/server/kv is first used.
const redis = new Map<string, string>(), sets = new Map<string, Set<string>>(), cmds: string[] = [];
process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
globalThis.fetch = (async (url: string, init: RequestInit) => {
  assert.equal(String(url), "https://upstash.test.invalid");
  const [c, k, ...a] = JSON.parse(String(init.body)) as string[]; cmds.push(c);
  let result: unknown = null;
  if (c === "GET") result = redis.get(k) ?? null;
  else if (c === "SET") { if (a.includes("NX") && redis.has(k)) result = null; else { redis.set(k, a[0]); result = "OK"; } }
  else if (c === "SADD") { const s = sets.get(k) ?? new Set(); a.forEach((m) => s.add(m)); sets.set(k, s); result = a.length; }
  else if (c === "SMEMBERS") result = Array.from(sets.get(k) ?? []);
  else throw new Error(`unexpected ${c}`);
  return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { createDenylist, deny, isDenied, memoryDenyStore, PHASH_SET, SHA_KEY } = await import("../lib/server/denylist");
const SHA = "a".repeat(64), PH = "f0f0f0f0f0f0f0f0";
const near = "f0f0f0f0f0f0f0f1", far = "0f0f0f0f0f0f0f0f";

test("deny/isDenied go to the shared KV (Upstash), not /tmp", async () => {
  const before = existsSync("/tmp/.data/denylist.json") ? statSync("/tmp/.data/denylist.json").mtimeMs : 0;
  assert.equal(await isDenied(SHA, PH), null);
  await deny(SHA, PH, "mock:{\"Porn\":0.93}");
  assert.ok(redis.has(SHA_KEY(SHA)));
  assert.deepEqual(Array.from(sets.get(PHASH_SET)!), [`${PH}|${SHA}`]);
  assert.equal((await isDenied(SHA, far))?.sha256, SHA, "exact sha");
  assert.equal((await isDenied("b".repeat(64), near))?.sha256, SHA, "phash near match");
  assert.equal(await isDenied("b".repeat(64), far), null);
  assert.equal(existsSync("/tmp/.data/denylist.json") ? statSync("/tmp/.data/denylist.json").mtimeMs : 0, before, "no file write");
  assert.ok(cmds.includes("SET") && cmds.includes("SADD") && cmds.includes("SMEMBERS"));
});

test("first reason wins (SET NX); re-deny doesn't duplicate the phash member", async () => {
  await deny(SHA, PH, "second");
  assert.match(JSON.parse(redis.get(SHA_KEY(SHA))!).reason, /^mock:/);
  assert.equal(sets.get(PHASH_SET)!.size, 1);
});

test("in-memory store (no KV env): same semantics, process-local", async () => {
  const d = createDenylist(memoryDenyStore(), 2);
  assert.equal(await d.isDenied(SHA, PH), null);
  await d.deny(SHA, PH, "r");
  assert.equal((await d.isDenied(SHA, far))?.reason, "r");
  assert.ok(await d.isDenied("c".repeat(64), near));
  assert.equal(await d.isDenied("c".repeat(64), far), null);
  assert.equal(await createDenylist(memoryDenyStore(), 2).isDenied(SHA, PH), null, "separate stores are independent");
});
