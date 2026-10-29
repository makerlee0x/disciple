/**
 * Site security pass: public GET rate-limit constants + Alchemy key policy.
 *   pnpm test:public-get-limits
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_GET_LIMITS, hitLimit, memoryCounter } from "../lib/server/limits";
import { alchemyKey } from "../lib/server/alchemyKey";

test("PUBLIC_GET_LIMITS: positive caps for img / share / trades / username nonce", () => {
  for (const [name, lim] of Object.entries(PUBLIC_GET_LIMITS)) {
    assert.ok(lim.limit > 0 && lim.limit <= 10_000, `${name}.limit`);
    assert.ok(lim.windowSec > 0 && lim.windowSec <= 3600, `${name}.windowSec`);
  }
  assert.equal(PUBLIC_GET_LIMITS.usernameNoncePerIp.limit, 30);
  assert.equal(PUBLIC_GET_LIMITS.usernameNoncePerIp.windowSec, 60);
});

test("hitLimit enforces the public-get windows (memory store)", async () => {
  const store = memoryCounter;
  const key = `test:img:${Date.now()}`;
  for (let i = 0; i < PUBLIC_GET_LIMITS.imgPerIp.limit; i++) {
    const r = await hitLimit(store, key, PUBLIC_GET_LIMITS.imgPerIp.limit, PUBLIC_GET_LIMITS.imgPerIp.windowSec);
    assert.equal(r.ok, true, `allowed #${i + 1}`);
  }
  const over = await hitLimit(store, key, PUBLIC_GET_LIMITS.imgPerIp.limit, PUBLIC_GET_LIMITS.imgPerIp.windowSec);
  assert.equal(over.ok, false);
  assert.ok(over.retryAfterSec > 0);
});

test("alchemyKey: prefer ALCHEMY_API_KEY; ignore NEXT_PUBLIC_ on Vercel/prod", () => {
  assert.equal(alchemyKey({ ALCHEMY_API_KEY: "server", NEXT_PUBLIC_ALCHEMY_API_KEY: "browser" }), "server");
  assert.equal(alchemyKey({ NEXT_PUBLIC_ALCHEMY_API_KEY: "browser", VERCEL: "1" }), undefined);
  assert.equal(alchemyKey({ NEXT_PUBLIC_ALCHEMY_API_KEY: "browser", NODE_ENV: "production" }), undefined);
  assert.equal(alchemyKey({ NEXT_PUBLIC_ALCHEMY_API_KEY: "browser", NODE_ENV: "development" }), "browser");
  assert.equal(alchemyKey({}), undefined);
});
