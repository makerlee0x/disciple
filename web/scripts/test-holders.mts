/** Unit tests for lib/holders (GET /api/holders): Transfer folding, ranking, pct/usd, labels, limit clamp. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTransfers, clampHoldersLimit, isAddr, rankHolders } from "../lib/holders";

const Z = "0x0000000000000000000000000000000000000000";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const E18 = BigInt(10) ** BigInt(18);

test("applyTransfers: mint, transfers, burn; zero balances dropped; mixed-case addresses merge", () => {
  const bal = applyTransfers({}, [
    { from: Z, to: A(1), value: BigInt(1000) * E18 },               // mint to curve
    { from: A(1), to: A(2), value: BigInt(300) * E18 },
    { from: A(1), to: A(3).toUpperCase().replace("0X", "0x"), value: BigInt(100) * E18 },
    { from: A(3), to: A(2), value: BigInt(100) * E18 },             // A3 exits fully
    { from: A(2), to: Z, value: BigInt(50) * E18 },                 // burn
    { from: A(2), to: A(4), value: BigInt(0) },                     // zero-value ignored
  ]);
  assert.deepEqual(bal, { [A(1)]: (BigInt(600) * E18).toString(), [A(2)]: (BigInt(350) * E18).toString() });
  assert.equal(bal[Z], undefined);
});

test("rankHolders: desc by balance, pct of supply, usd at mcap, labels, limit", () => {
  const bal = { [A(1)]: (BigInt(600) * E18).toString(), [A(2)]: (BigInt(350) * E18).toString(), [A(5)]: (BigInt(50) * E18).toString() };
  const h = rankHolders(bal, { totalSupply: BigInt(1000) * E18, mcapUsd: 10_000, labels: { [A(1)]: "curve", [A(5)]: "locker" }, limit: 2 });
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => x.address), [A(1), A(2)]);
  assert.equal(h[0].label, "curve"); assert.equal(h[1].label, null);
  assert.equal(h[0].pct, 60); assert.equal(h[1].pct, 35);
  assert.equal(h[0].usd, 6000); assert.equal(h[1].usd, 3500);
  assert.equal(h[1].balance, (BigInt(350) * E18).toString());
  assert.equal(rankHolders(bal, { totalSupply: BigInt(1000) * E18, mcapUsd: null, labels: {}, limit: 5 })[0].usd, null);
  assert.equal(rankHolders(bal, { totalSupply: BigInt(1000) * E18, mcapUsd: 1, labels: {}, limit: 5 }).at(-1)!.label, null);
});

test("ties break by address; huge balances don't overflow", () => {
  const big = (BigInt(1) << BigInt(200)).toString();
  const h = rankHolders({ [A(9)]: big, [A(3)]: big }, { totalSupply: BigInt(2) << BigInt(200), mcapUsd: 2, labels: {}, limit: 10 });
  assert.deepEqual(h.map((x) => x.address), [A(3), A(9)]);
  assert.equal(h[0].pct, 50); assert.equal(h[0].usd, 1);
});

test("limit clamp 1–100 (default 50) and address validation", () => {
  assert.equal(clampHoldersLimit(null), 50); assert.equal(clampHoldersLimit("0"), 50); assert.equal(clampHoldersLimit("-3"), 1);
  assert.equal(clampHoldersLimit("7"), 7); assert.equal(clampHoldersLimit("1e9"), 100); assert.equal(clampHoldersLimit("abc"), 50);
  assert.ok(isAddr(A(1))); assert.ok(!isAddr("0x12")); assert.ok(!isAddr(null)); assert.ok(!isAddr(`${A(1)}00`));
});

test("protocolLabels: FeeRouter + RewardsVault + AnonLaunchers are 'locker' (data retest #3); pool / curve as before; zero skipped", async () => {
  const { protocolLabels } = await import("../lib/holders");
  const { DEPLOYMENTS } = await import("../lib/chains");
  const d = DEPLOYMENTS[46630];
  const vault = "0x1f42909f1dea0f6bd0dbd19e05f2e9505d748b9e", curve = A(7);
  const l = protocolLabels(d, { curve: curve.toUpperCase().replace("0X", "0x"), lockers: [vault, undefined, Z] });
  const feeRouter = d.feeRouter.toLowerCase();   // the active stack's FeeRouter (was 0xe7ab…52d9 before the v5 redeploy)
  assert.equal(l[feeRouter], "locker");
  assert.equal(l[vault], "locker");
  assert.equal(l[d.lockedLP.toLowerCase()], "locker");
  assert.equal(l[d.poolManager.toLowerCase()], "pool");
  assert.equal(l[d.hook.toLowerCase()], "pool");
  assert.equal(l[curve], "curve");
  assert.equal(l[Z], undefined);
  const h = rankHolders({ [A(2)]: "5", [feeRouter]: "1" }, { totalSupply: BigInt(6), mcapUsd: 6, labels: l, limit: 5 });
  assert.equal(h.find((x) => x.address === feeRouter)!.label, "locker");
});

test("holderKinds (GAME contract): PoolManager + hook = pool; LockedLP + Migration = locker; 0x…dEaD + 0x0 = burn; others = holder", async () => {
  const { holderKinds, kindOf, rankHolders, BURN_ADDRESS } = await import("../lib/holders");
  const { DEPLOYMENTS } = await import("../lib/chains");
  const d = DEPLOYMENTS[46630];
  const curve = A(7), vault = A(8);
  const k = holderKinds(d, { curve, lockers: [vault, undefined, Z] });
  assert.equal(k[d.poolManager.toLowerCase()], "pool");
  assert.equal(k[d.hook.toLowerCase()], "pool");
  assert.equal(k[curve], "pool");                                   // pre-grad liquidity
  assert.equal(k[d.lockedLP.toLowerCase()], "locker");
  assert.equal(k[d.migration.toLowerCase()], "locker");             // label stays "pool"; kind = locker
  assert.equal(k[vault], "locker");
  assert.equal(k[BURN_ADDRESS], "burn"); assert.equal(k[Z], "burn");
  assert.equal(BURN_ADDRESS, "0x000000000000000000000000000000000000dead"); // = contracts/src/LockedLP.sol BURN
  assert.equal(kindOf(A(99), k), "holder");
  assert.equal(kindOf("0x000000000000000000000000000000000000dEaD"), "burn", "burn sinks need no map");
  const bal = { [d.poolManager.toLowerCase()]: "500", [d.lockedLP.toLowerCase()]: "300", [BURN_ADDRESS]: "150", [A(42)]: "50" };
  const h = rankHolders(bal, { totalSupply: BigInt(1000), mcapUsd: 1000, labels: {}, kinds: k, limit: 10 });
  assert.deepEqual(h.map((x) => x.kind), ["pool", "locker", "burn", "holder"]);
  assert.equal(rankHolders({ [A(42)]: "1" }, { totalSupply: BigInt(1), mcapUsd: null, labels: {}, limit: 1 })[0].kind, "holder", "no kinds map ⇒ holder");
});

test("rankHolders: community rewards wallet and RewardsVault are left off the list (case-insensitive)", async () => {
  const { protocolLabels, holderKinds, rankHolders, isExcludedHolder, EXCLUDED_HOLDER_ADDRESSES } = await import("../lib/holders");
  const community = "0x7b36bDC13FF6AcaA0F285c0C3d818D1d703d0c1E";
  const vault = "0xf1a2784de1ded172f4b10b242f124f60a6ab38c0";
  assert.deepEqual([...EXCLUDED_HOLDER_ADDRESSES], [community, vault]);
  assert.ok(isExcludedHolder(community));
  assert.ok(isExcludedHolder(community.toUpperCase().replace("0X", "0x")));
  assert.ok(isExcludedHolder(vault.toUpperCase().replace("0X", "0x")));
  assert.ok(!isExcludedHolder(A(2)));

  // Revert of the locker-label idea: these two are not tagged locker (unless some other locker list also contains them).
  const l = protocolLabels({});
  const k = holderKinds({});
  assert.equal(l[community.toLowerCase()], undefined);
  assert.equal(l[vault.toLowerCase()], undefined);
  assert.equal(k[community.toLowerCase()], undefined);
  assert.equal(k[vault.toLowerCase()], undefined);

  const playerA = A(2); // 400 — first
  const playerB = A(3); // 150 — was third while the community wallet sat in second; becomes second after the drop
  const playerC = A(4); // 50
  const lockedLP = A(5);
  const labels = { [lockedLP]: "locker" as const };
  const kinds = { [lockedLP]: "locker" as const };
  // mixed-case keys still match
  const communityKey = community.toUpperCase().replace("0X", "0x");
  const vaultKey = vault;
  const bal = {
    [playerA]: "400",
    [communityKey]: "300",
    [playerB]: "150",
    [vaultKey]: "50",
    [playerC]: "50",
    [lockedLP]: "50",
  };
  const shown = rankHolders(bal, { totalSupply: BigInt(1000), mcapUsd: 1000, labels, kinds, limit: 10 });
  assert.deepEqual(shown.map((x) => x.address), [playerA, playerB, playerC, lockedLP]);
  assert.ok(!shown.some((x) => isExcludedHolder(x.address)));
  // percentages stay of total supply (1000), not of the 650 still on the list
  assert.equal(shown[0].pct, 40);
  assert.equal(shown[0].usd, 400);
  assert.equal(shown[1].pct, 15);
  assert.equal(shown[2].pct, 5);
  assert.equal(shown[3].pct, 5);
  assert.equal(shown[0].label, null); assert.equal(shown[0].kind, "holder");
  assert.equal(shown[1].label, null); assert.equal(shown[1].kind, "holder");
  assert.equal(shown[2].label, null); assert.equal(shown[2].kind, "holder");
  assert.equal(shown[3].label, "locker"); assert.equal(shown[3].kind, "locker");
  // ranks move up: with the two addresses still in the list, playerB would be third
  const including = rankHolders(
    { [playerA]: "400", [A(9)]: "300", [playerB]: "150", [playerC]: "50", [lockedLP]: "50" },
    { totalSupply: BigInt(1000), mcapUsd: 1000, labels, kinds, limit: 10 },
  );
  assert.deepEqual(including.map((x) => x.address), [playerA, A(9), playerB, playerC, lockedLP]);
  assert.equal(including.findIndex((x) => x.address === playerB), 2);
  assert.equal(shown.findIndex((x) => x.address === playerB), 1);
  // a later holder still fills the limit after a dropped row (filter before slice)
  const capped = rankHolders(bal, { totalSupply: BigInt(1000), mcapUsd: 1000, labels, kinds, limit: 3 });
  assert.deepEqual(capped.map((x) => x.address), [playerA, playerB, playerC]);
});
