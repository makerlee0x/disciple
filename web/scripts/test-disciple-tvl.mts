/**
 * DiscipleHook TVL is poolState reserves marked at anchorX128. No getLiquidity input.
 * Run: cd web && node --experimental-strip-types --test scripts/test-disciple-tvl.mts
 * (or tsx --test). The snapshot is a live 4663 poolState read used only as a fixture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DISCIPLE_POOL, DISCIPLE_V4_QUOTER } from "../lib/disciple/catalog.ts";
import { liquidityUsdForHome, quoteRawToUsd, reservesFromPoolState, tvlFromPoolState, tvlQuoteRaw } from "../lib/disciple/tvl.ts";

const COIN = 44814216947137264326696n;
const QUOTE = 104414801n;
const ANCHOR = 676691368068158081113397n;

test("published PoolKey fee is 0 and the quoter is the RH V4Quoter", () => {
  assert.equal(DISCIPLE_POOL.fee, 0);
  assert.equal(DISCIPLE_POOL.tickSpacing, 1);
  assert.equal(DISCIPLE_POOL.id, "0xddbfa6efd15715013f50e7f1cdceaab3b69b0b8e4c9d4b47fcc28e47f6a80e8f");
  assert.equal(DISCIPLE_V4_QUOTER, "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
});

test("TVL from poolState anchor matches the reserve fixture; home liquidity ignores anything else", () => {
  assert.equal(tvlQuoteRaw(COIN, QUOTE, ANCHOR), 193533123n);
  const t = tvlFromPoolState({ coinReserve: COIN, quoteReserve: QUOTE, anchorX128: ANCHOR });
  assert.equal(t.tvlQuoteRaw, 193533123n);
  assert.ok(Math.abs((t.liquidityUsd ?? 0) - 193.533123) < 1e-6);
  assert.equal(quoteRawToUsd(193533123n, null), null);
  const tuple = reservesFromPoolState(["0x168661C52E5922288dFb2b3f323b6Cf90eb21e18", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", true, false, false, false, COIN, QUOTE, ANCHOR]);
  assert.equal(tuple.coinReserve, COIN);
  assert.equal(tuple.anchorX128, ANCHOR);
  assert.equal(liquidityUsdForHome({}), 0);
  assert.equal(liquidityUsdForHome({ liquidityUsd: t.liquidityUsd }), t.liquidityUsd);
});
