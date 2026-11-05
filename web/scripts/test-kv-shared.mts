/** Shared-KV fail-closed + trusted-proxy clientIp (audit mainnet-prep). */
import assert from "node:assert/strict";
import { requiresSharedKv, resetKvForTests } from "../lib/server/kv";
import { clientIp } from "../lib/server/limits";

assert.equal(requiresSharedKv({}), false);
assert.equal(requiresSharedKv({ NODE_ENV: "development" }), false);
assert.equal(requiresSharedKv({ NODE_ENV: "test" }), false);
assert.equal(requiresSharedKv({ NODE_ENV: "production" }), true);
assert.equal(requiresSharedKv({ NODE_ENV: "production", KV_ALLOW_LOCAL: "1" }), false);
assert.equal(requiresSharedKv({ VERCEL: "1" }), true);
assert.equal(requiresSharedKv({ VERCEL_ENV: "preview" }), true);
assert.equal(requiresSharedKv({ VERCEL_ENV: "production" }), true);
assert.equal(requiresSharedKv({ VERCEL_ENV: "development" }), false);
assert.equal(requiresSharedKv({ VERCEL: "1", NEXT_PHASE: "phase-production-build" }), false);

resetKvForTests();
const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
assert.equal(clientIp(h({ "x-forwarded-for": "9.9.9.9" }), {}), "unknown");
assert.equal(clientIp(h({ "x-forwarded-for": "9.9.9.9" }), { VERCEL: "1" }), "9.9.9.9");
assert.equal(clientIp(h({ "x-real-ip": "8.8.8.8" }), { TRUSTED_PROXY: "1" }), "8.8.8.8");
console.log("ok: kv shared + clientIp trusted-proxy");
