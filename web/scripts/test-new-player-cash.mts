// SITE new-player cash: Get test cash gating (testnet only), plain copy, Deposit link hashes, /api/test-cash guards.
// pnpm test:new-player-cash
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const JARGON = /on-?chain|\btx\b|transaction|relay|gas|paymaster|mint|wallet|USDG|ERC-?20|testnet|network/i;

test("Get test cash: on for RH testnet 46630 (default chain)", async () => {
  delete process.env.NEXT_PUBLIC_CHAIN_ID;
  const m = await import("../lib/testCash");
  assert.equal(m.TEST_CASH_CHAIN_ID, 46630);
  assert.equal(m.TEST_CASH_ENABLED, true);
  assert.equal(m.TEST_CASH_USD, 500);
});

test("Get test cash: never enabled on mainnet config", async () => {
  const { CHAIN } = await import("../lib/config");
  assert.notEqual(CHAIN.id, 46630);
  const out = execFileSync(process.execPath, ["--import", "tsx", "-e",
    "import('./lib/chains.ts').then(async (c) => { const t = await import('./lib/testCash.ts'); const C = c.ACTIVE_CHAIN ? c : c.default, T = t.TEST_CASH_ENABLED !== undefined ? t : t.default; console.log(JSON.stringify({ chain: C.ACTIVE_CHAIN.id, on: T.TEST_CASH_ENABLED })); })"],
  { env: { ...process.env, NEXT_PUBLIC_CHAIN_ID: String(CHAIN.id) }, cwd: process.cwd() }).toString().trim().split("\n").pop()!;
  const r = JSON.parse(out) as { chain: number; on: boolean };
  assert.equal(r.chain, CHAIN.id);
  assert.equal(r.on, false);
});

test("new copy is plain (dollars, no jargon)", async () => {
  const { TEST_CASH_COPY } = await import("../lib/testCash");
  const { FIRST_BOOST_COPY } = await import("../lib/firstBoost");
  const strings = [TEST_CASH_COPY.button, TEST_CASH_COPY.busy, TEST_CASH_COPY.done(500), TEST_CASH_COPY.note, TEST_CASH_COPY.wait(42), TEST_CASH_COPY.off,
    TEST_CASH_COPY.needsCash, TEST_CASH_COPY.deposit, FIRST_BOOST_COPY.balanceOf("$245.00", "STRATEGY"), FIRST_BOOST_COPY.paidFrom("STRATEGY")];
  for (const s of strings) assert.doesNotMatch(s, JARGON, s);
  assert.equal(TEST_CASH_COPY.needsCash, "Add cash first to turn on one-tap.");
  assert.equal(TEST_CASH_COPY.done(500), "Added $500 in test cash.");
});

test("Deposit link opens the Cash panel hash", async () => {
  const { DEPOSIT_HREF, SETTINGS_HASHES } = await import("../lib/cashLink");
  assert.equal(DEPOSIT_HREF, "/profile#cash");
  assert.ok((SETTINGS_HASHES as readonly string[]).includes(new URL(DEPOSIT_HREF, "https://x.test").hash));
  assert.ok((SETTINGS_HASHES as readonly string[]).includes("#settings"));
});

test("/api/test-cash: 503 without the faucet key, 400 for a bad address, 400 off testnet", async () => {
  const saved = process.env.DRIP_FAUCET_KEY;
  delete process.env.DRIP_FAUCET_KEY;
  const { POST } = await import("../app/api/test-cash/route");
  const req = (body: unknown) => new Request("http://x.test/api/test-cash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const warn = console.warn; console.warn = () => {};
  try {
    let r = await POST(req({ address: "0x1111111111111111111111111111111111111111" }));
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { ok: boolean }).ok, false);
    process.env.DRIP_FAUCET_KEY = "0x" + "11".repeat(32);   // dummy (never used: the address check fails first)
    r = await POST(req({ address: "nope" }));
    assert.equal(r.status, 400);
    process.env.NEXT_PUBLIC_CHAIN_ID = "46666";
    r = await POST(req({ address: "0x1111111111111111111111111111111111111111" }));
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { reason: string }).reason, "testnet only");
  } finally {
    console.warn = warn;
    delete process.env.NEXT_PUBLIC_CHAIN_ID;
    if (saved === undefined) delete process.env.DRIP_FAUCET_KEY; else process.env.DRIP_FAUCET_KEY = saved;
  }
});
