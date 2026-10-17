// Unit tests for the relayer key selection (W-1 residual): production FAILS CLOSED — no RELAYER_PRIVATE_KEY, an invalid
// one, or one equal to the faucet key ⇒ RelayerNotConfiguredError and /api/bundler 503 "relayer not configured"; the
// faucet key never signs bundles in production. Non-production keeps the DRIP_FAUCET_KEY fallback with a warning.
//   pnpm test:relayer-key   (pure: random throwaway keys, no RPC, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { isProductionRelayer, isRelayerNotConfigured, relayerIsFaucet, relayerKey, RelayerNotConfiguredError } from "../lib/server/relayer";

const FAUCET = generatePrivateKey(), RELAYER = generatePrivateKey();
const PROD = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" } as NodeJS.ProcessEnv;
const PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
const notConfigured = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof RelayerNotConfiguredError && isRelayerNotConfigured(e) && e.status === 503 && /^relayer not configured/.test((e as Error).message));
const quiet = <T,>(fn: () => T): T => { const w = console.warn, er = console.error; console.warn = console.error = () => {}; try { return fn(); } finally { console.warn = w; console.error = er; } };

test("production detection: Vercel prod, self-hosted NODE_ENV=production; not preview/dev; RELAYER_LOCAL_TEST only off Vercel", () => {
  assert.equal(isProductionRelayer(PROD), true);
  assert.equal(isProductionRelayer({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv), true);
  assert.equal(isProductionRelayer({ NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
  assert.equal(isProductionRelayer({ NODE_ENV: "production", RELAYER_LOCAL_TEST: "1" } as NodeJS.ProcessEnv), false);
  assert.equal(isProductionRelayer({ ...PROD, RELAYER_LOCAL_TEST: "1" }), true); // can't opt out on Vercel prod
  assert.equal(isProductionRelayer(PREVIEW), false);
  assert.equal(isProductionRelayer(DEV), false);
  assert.equal(isProductionRelayer({ NODE_ENV: "test" } as NodeJS.ProcessEnv), false);
});

test("production: RELAYER_PRIVATE_KEY unset ⇒ fail closed (never the faucet key)", () => quiet(() => {
  notConfigured(() => relayerKey({ ...PROD, DRIP_FAUCET_KEY: FAUCET }));
  notConfigured(() => relayerKey({ NODE_ENV: "production", DRIP_FAUCET_KEY: FAUCET } as NodeJS.ProcessEnv));
  notConfigured(() => relayerKey({ ...PROD }));
  assert.equal(relayerIsFaucet({ ...PROD, DRIP_FAUCET_KEY: FAUCET }), false); // drip doesn't route through the relayer cursor
}));

test("production: relayer key deriving to the faucet address ⇒ fail closed (any case / missing 0x)", () => quiet(() => {
  notConfigured(() => relayerKey({ ...PROD, RELAYER_PRIVATE_KEY: FAUCET, DRIP_FAUCET_KEY: FAUCET }));
  notConfigured(() => relayerKey({ ...PROD, RELAYER_PRIVATE_KEY: FAUCET.toUpperCase().replace("0X", "0x"), DRIP_FAUCET_KEY: FAUCET }));
  notConfigured(() => relayerKey({ ...PROD, RELAYER_PRIVATE_KEY: FAUCET.slice(2), DRIP_FAUCET_KEY: FAUCET }));
  notConfigured(() => relayerKey({ ...PROD, RELAYER_PRIVATE_KEY: "0x1234", DRIP_FAUCET_KEY: FAUCET })); // invalid key
}));

test("production: a distinct relayer key is used", () => {
  assert.equal(relayerKey({ ...PROD, RELAYER_PRIVATE_KEY: RELAYER, DRIP_FAUCET_KEY: FAUCET }), RELAYER);
  assert.equal(relayerKey({ ...PROD, RELAYER_PRIVATE_KEY: RELAYER }), RELAYER);
  assert.equal(relayerIsFaucet({ ...PROD, RELAYER_PRIVATE_KEY: RELAYER, DRIP_FAUCET_KEY: FAUCET }), false);
});

test("non-production keeps the faucet fallback with a one-time warning", () => {
  const warns: string[] = []; const w = console.warn; console.warn = (m: string) => warns.push(String(m));
  try {
    for (const env of [PREVIEW, DEV, { NODE_ENV: "production", RELAYER_LOCAL_TEST: "1" } as NodeJS.ProcessEnv]) {
      assert.equal(relayerKey({ ...env, DRIP_FAUCET_KEY: FAUCET }), FAUCET);
      assert.equal(relayerIsFaucet({ ...env, DRIP_FAUCET_KEY: FAUCET }), true);
      assert.equal(relayerKey({ ...env, RELAYER_PRIVATE_KEY: RELAYER, DRIP_FAUCET_KEY: FAUCET }), RELAYER);
      assert.equal(relayerIsFaucet({ ...env, RELAYER_PRIVATE_KEY: RELAYER, DRIP_FAUCET_KEY: FAUCET }), false);
      assert.equal(relayerIsFaucet({ ...env, RELAYER_PRIVATE_KEY: FAUCET, DRIP_FAUCET_KEY: FAUCET }), true);
    }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /DRIP_FAUCET_KEY/);
    assert.ok(!warns[0].includes(FAUCET.slice(2)), "never logs key material");
  } finally { console.warn = w; }
  quiet(() => notConfigured(() => relayerKey({ ...DEV })));
});

test("/api/bundler: production without a dedicated relayer key answers 503 'relayer not configured' (no RPC, no signing)", async () => {
  const saved = { ...process.env };
  const fetchSaved = globalThis.fetch;
  let fetched = 0; globalThis.fetch = (async () => { fetched++; throw new Error("network disabled in test"); }) as typeof fetch;
  try {
    for (const k of ["ALCHEMY_API_KEY", "NEXT_PUBLIC_ALCHEMY_API_KEY", "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "RELAYER_PRIVATE_KEY"]) delete process.env[k];
    Object.assign(process.env, { VERCEL_ENV: "production", NODE_ENV: "production", DRIP_FAUCET_KEY: FAUCET, KV_LOCAL_FILE: `/tmp/disciple-kv-test-${process.pid}.json` });
    const { POST } = await import("../app/api/bundler/route");
    const op = { sender: "0x1111111111111111111111111111111111111111", nonce: "0x0", callData: "0x", signature: "0x" };
    for (const [method, params] of [["eth_sendUserOperation", [op, "0x0000000071727De22E5E9d8BAf0edAc6f37da032"]], ["disciple_sendUserOperationSync", [op]], ["disciple_warm", []]] as const) {
      for (const relayer of [undefined, FAUCET]) {
        if (relayer) process.env.RELAYER_PRIVATE_KEY = relayer; else delete process.env.RELAYER_PRIVATE_KEY;
        const res = await quietAsync(() => POST(new Request("http://localhost/api/bundler", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) })));
        assert.equal(res.status, 503, `${method} relayer=${relayer ? "faucet" : "unset"}`);
        const j = await res.json() as { id: number; error: { message: string } };
        assert.equal(j.id, 7);
        assert.match(j.error.message, /relayer not configured/);
      }
    }
    assert.equal(fetched, 0, "no RPC before failing closed");
  } finally { process.env = saved; globalThis.fetch = fetchSaved; }
});
async function quietAsync<T>(fn: () => Promise<T>): Promise<T> { const w = console.warn, er = console.error; console.warn = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = er; } }
