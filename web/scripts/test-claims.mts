// Unit tests for the claims stack (pure, no RPC): v4 ABI coverage, session policy for claims/deposits,
// escrow unlock labels, custom-error decoding.   pnpm test:claims
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { abiHas } from "../lib/claims/capabilities";
import { checkCalls, depositTotal, PolicyError, type PolicyCfg } from "../lib/aa/policy";
import { depositNeeded, unlockLabel, unlocked, withdrawCall } from "../lib/claims/referralGate";
import { claimErrorText, fmtUsd, toUsd } from "../lib/claims/common";
import { AAError } from "../lib/aa/core";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, referralRegistryAbi, usdgDepositNotifierAbi as depositNotifierAbi } from "../lib/abi";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const LP = A(1), ROUTER = A(2), TWM = A(3), FR = A(4), NOTI = A(5), USDG = A(6), ME = A(7), OTHER = A(8);
const cfg: PolicyCfg = { launchpad: LP, router: ROUTER, trampWallManager: TWM, mintable: [], defaultLimit: BigInt(10) ** BigInt(30), feeRouter: FR, usdgDepositNotifier: NOTI, usdg: USDG };
const st = () => ({ expiresAt: Date.now() + 60_000, spent: {} });
const pcNoCurve = { readContract: async () => { throw new Error("not a curve"); } } as never;
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
const call = (to: Address, data: Hex) => ({ to, data });

test("abiHas: v4 ABIs carry every claim entry point the UI calls", () => {
  for (const f of ["creatorAccrued", "claimCreatorFees", "creatorTokenAccrued", "claimCreatorTokenFees", "referrerAccrued", "claimReferrerFees"]) assert.ok(abiHas(feeRouterAbi, f), f);
  for (const f of ["curveOf", "modeOf", "claim", "creatorOf"]) assert.ok(abiHas(launchpadAbi, f), f);
  assert.ok(abiHas(bondingCurveAbi, "pendingRewards"));
  for (const f of ["minDeposit", "deposit", "escrowCount", "escrowOf", "withdraw", "LOCK_PERIOD", "usdg"]) assert.ok(abiHas(depositNotifierAbi, f), f);
  for (const f of ["pending", "claimMany", "stealthOwnerOf"]) assert.ok(abiHas(anonLauncherAbi, f), f);
  for (const f of ["referrerOf", "pendingReferrer", "usdgDeposited", "usdgGate"]) assert.ok(abiHas(referralRegistryAbi, f), f);
});
test("depositNeeded: reach the gate, never below minDeposit", () => {
  const E = BigInt(10) ** BigInt(18);
  assert.equal(depositNeeded({ min: E, gate: BigInt(10) * E, deposited: BigInt(0) }), BigInt(10) * E);
  assert.equal(depositNeeded({ min: E, gate: BigInt(10) * E, deposited: BigInt(9) * E + BigInt(1) }), E);
  assert.equal(depositNeeded({ min: BigInt(2) * E, gate: null, deposited: BigInt(0) }), BigInt(2) * E);
  assert.equal(depositNeeded({ min: null, gate: E, deposited: BigInt(0) }), null);
});

test("policy: FeeRouter claim selectors pass, anything else on FeeRouter is rejected", async () => {
  for (const [fn, arg] of [["claimCreatorFees", A(9)], ["claimReferrerFees", USDG], ["claimCreatorTokenFees", A(9)]] as const) {
    const data = encodeFunctionData({ abi: parseAbi([`function ${fn}(address) returns (uint256)`]), functionName: fn, args: [arg] });
    await checkCalls(pcNoCurve, cfg, st(), [call(FR, data)], ME);
  }
  const bad = encodeFunctionData({ abi: parseAbi(["function setTreasury(address)"]), functionName: "setTreasury", args: [OTHER] });
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [call(FR, bad)], ME), PolicyError);
});
test("policy: without feeRouter configured, claim calls are rejected (fail closed)", async () => {
  const data = encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [A(9)] });
  await assert.rejects(checkCalls(pcNoCurve, { ...cfg, feeRouter: undefined }, st(), [call(FR, data)], ME), PolicyError);
});
test("policy: deposit needs exact paired approve and must be for the account", async () => {
  const amt = BigInt(10) * BigInt(10) ** BigInt(18);
  const dep = (w: Address, a: bigint) => call(NOTI, encodeFunctionData({ abi: depositNotifierAbi, functionName: "deposit", args: [w, a] }));
  const ap = (a: bigint) => call(USDG, encodeFunctionData({ abi: erc20, functionName: "approve", args: [NOTI, a] }));
  assert.equal(depositTotal([ap(amt), dep(ME, amt)], NOTI), amt);
  await checkCalls(pcNoCurve, cfg, st(), [ap(amt), dep(ME, amt)], ME);
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [ap(amt + BigInt(1)), dep(ME, amt)], ME), /equal the deposit/);
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [ap(amt), dep(OTHER, amt)], ME), /this account/);
  await checkCalls(pcNoCurve, cfg, st(), [call(NOTI, withdrawCall([0, 2]).data)], ME);
  const tr = call(NOTI, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [OTHER, amt] }));
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [tr], ME), PolicyError);
});

test("unlock countdown and unlocked()", () => {
  const now = 1_700_000_000;
  assert.equal(unlockLabel(now - 1, now), "Unlocked");
  assert.equal(unlockLabel(now + 3 * 86400 + 4 * 3600 + 5, now), "Unlocks in 3d 4h");
  assert.equal(unlockLabel(now + 2 * 3600 + 15 * 60, now), "Unlocks in 2h 15m");
  assert.equal(unlockLabel(now + 20, now), "Unlocks in 1m");
  assert.equal(unlocked({ id: 0, amount: BigInt(1), unlockAt: now }, now), true);
  assert.equal(unlocked({ id: 0, amount: BigInt(1), unlockAt: now + 1 }, now), false);
});

test("revert decoding: Locked / BelowMinimum / NothingToClaim → plain copy", () => {
  const wrap = (data: Hex) => new AAError("Reverted", "reverted", { revertData: data });
  const locked = encodeErrorResult({ abi: depositNotifierAbi, errorName: "Locked", args: [BigInt(3), BigInt(1_800_000_000)] });
  assert.match(claimErrorText(wrap(locked)), /^Deposit still locked until /);
  const below = encodeErrorResult({ abi: depositNotifierAbi, errorName: "BelowMinimum", args: [BigInt(10)] });
  assert.equal(claimErrorText(wrap(below)), "Deposit is below the minimum.");
  const none = encodeErrorResult({ abi: feeRouterAbi, errorName: "NothingToClaim" });
  assert.equal(claimErrorText(wrap(none)), "Nothing to claim yet.");
  assert.equal(claimErrorText(new Error("User rejected the request")), "Cancelled.");
});
test("USD helpers", () => {
  const a = { address: USDG, symbol: "USDG", decimals: 6, usd: 1 };
  assert.equal(toUsd(BigInt(12_340_000), a), 12.34);
  assert.equal(toUsd(BigInt(1), { ...a, usd: null }), null);
  assert.equal(fmtUsd(12.34), "$12.34");
});

test("anon: private rockets never produce a direct (msg.sender) claim; they are signed (claimManyBySig)", async () => {
  const { creatorClaimCalls } = await import("../lib/claims/creatorFees");
  const { anonLauncherAddr, anonLauncherLegacyAddr } = await import("../lib/claims/capabilities");
  const v2 = anonLauncherAddr()!, v1 = anonLauncherLegacyAddr()!;
  assert.equal(v2.toLowerCase(), "0x526784706e5ef369412abe65213ed65256182c6b"); // v6 AnonLauncher
  assert.equal(v1.toLowerCase(), "0x73a2a6e049aa21a5c440f3bc358de37fe3f7c509"); // legacy = the v5 launcher
  const asset = { address: A(9), symbol: "NITE", decimals: 18, usd: null };
  const caps = { creatorFees: true, referrerFees: true, creatorTokenFees: true, crew: true, referralGate: true, anonClaims: true };
  const row = { token: A(9), claimable: BigInt(0), anon: true, launcher: v1, tokenSide: { asset, claimable: BigInt(0), claimed: BigInt(0) }, tokenUnclaimable: { asset, raw: BigInt(5) } };
  assert.equal(creatorClaimCalls([row], caps, ME).length, 0);                      // only an unclaimable legacy share
  // gasless: AnonLauncher claims go through claimManyBySig (anonSigClaimCalls / signedAnonClaimCalls), never claimMany
  assert.equal(creatorClaimCalls([{ ...row, claimable: BigInt(1) }, { ...row, token: A(8), launcher: v2, claimable: BigInt(1) }], caps, ME).length, 0);
  const stealthRow = { ...row, launcher: v2, claimable: BigInt(1), stealth: { owner: A(7), ephemeralPubKey: "0x02" as const } };
  assert.equal(creatorClaimCalls([stealthRow], caps, ME).length, 0);               // signed path (anonSigClaimCalls)
});

test("lp-accrue: creator / private / referral claims hit the CurveFeeVault side that holds the balance", async () => {
  const { creatorClaimCalls, referralClaimCalls, anonSigClaimCalls } = await import("../lib/claims/creatorFees");
  const { anonLauncherAddr } = await import("../lib/claims/capabilities");
  const { curveFeeVaultAbi, vaultClaimDomain } = await import("../lib/claims/vault");
  const { decodeFunctionData } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { deployment } = await import("../lib/chains");
  const v2 = anonLauncherAddr()!, VAULT = A(0xfee), fr = deployment().feeRouter;
  const caps = { creatorFees: true, referrerFees: true, creatorTokenFees: false, crew: false, referralGate: false, anonClaims: true };
  const fn = (c: { data: Hex }, abi: readonly unknown[]) => decodeFunctionData({ abi: abi as never, data: c.data }) as { functionName: string; args: readonly unknown[] };
  // wallet rocket: vault-only balance → only the vault call; both sides → FeeRouter + vault; no vault → FeeRouter as before
  const w = { token: A(9), claimable: BigInt(5), tokenSide: null, vault: VAULT, vaultClaimable: BigInt(5), baseClaimable: BigInt(0) };
  assert.deepEqual(creatorClaimCalls([w], caps, ME).map((c) => c.to), [VAULT]);
  assert.equal(fn(creatorClaimCalls([w], caps, ME)[0], curveFeeVaultAbi).functionName, "claimCreatorFees");
  assert.deepEqual(creatorClaimCalls([{ ...w, claimable: BigInt(7), baseClaimable: BigInt(2) }], caps, ME).map((c) => c.to), [fr, VAULT]);
  assert.deepEqual(creatorClaimCalls([{ token: A(9), claimable: BigInt(1), tokenSide: null }], caps, ME).map((c) => c.to), [fr]);
  // private rockets never get a direct (msg.sender) call: they are signed, so the gasless relayer can submit them
  const p = { ...w, anon: true, launcher: v2 };
  assert.equal(creatorClaimCalls([p], caps, ME).length, 0);
  assert.equal(creatorClaimCalls([{ ...p, baseClaimable: BigInt(1), claimable: BigInt(6) }], caps, ME).length, 0);
  // wallet-owned private rocket (e.g. launchAnonWithUsdg for a named player): the wallet signs the vault claim to itself
  const { CLAIM_TYPES } = await import("../lib/anon");
  const { ACTIVE_CHAIN } = await import("../lib/chains");
  const { recoverTypedDataAddress } = await import("viem");
  const wk = "0x00000000000000000000000000000000000000000000000000000000000a11ce" as Hex;
  const wallet = privateKeyToAccount(wk);
  const pcW = { readContract: async ({ functionName }: { functionName: string }) => { assert.equal(functionName, "sigNonces"); return BigInt(1); } } as never;
  const wc = await anonSigClaimCalls(pcW, [p], wallet.address, undefined, wallet);
  assert.deepEqual(wc.map((c) => c.to), [VAULT]);
  const dw = fn(wc[0], curveFeeVaultAbi);
  assert.equal(dw.functionName, "claimManyAsStealthBySig");
  const rw = dw.args[0] as { owner: Address; tokens: Address[]; to: Address; relayerFeeBps: bigint; deadline: bigint; sig: Hex };
  assert.equal(rw.owner, wallet.address);
  assert.equal(rw.to, wallet.address);
  assert.equal(await recoverTypedDataAddress({ domain: vaultClaimDomain(ACTIVE_CHAIN.id, VAULT), types: CLAIM_TYPES, primaryType: "Claim",
    message: { owner: rw.owner, tokens: rw.tokens, to: rw.to, relayerFeeBps: rw.relayerFeeBps, nonce: BigInt(1), deadline: rw.deadline }, signature: rw.sig }), wallet.address);
  // no wallet signer (not gasless) → nothing signed for a wallet-owned row
  assert.equal((await anonSigClaimCalls(pcW, [p], wallet.address, undefined, null)).length, 0);
  // stealth-owned: signed by the stealth key, vault domain + sigNonces, recovers to the owner
  const key = "0x00000000000000000000000000000000000000000000000000000000005ea17f" as Hex;
  const owner = privateKeyToAccount(key).address;
  const pcSig = { readContract: async ({ functionName }: { functionName: string }) => { assert.equal(functionName, "sigNonces"); return BigInt(3); } } as never;
  const sc = await anonSigClaimCalls(pcSig, [{ ...p, stealth: { owner, ephemeralPubKey: "0x02" as Hex } }], ME, () => key);
  assert.equal(sc.length, 1);
  assert.equal(sc[0].to, VAULT);
  const d2 = fn(sc[0], curveFeeVaultAbi);
  assert.equal(d2.functionName, "claimManyAsStealthBySig");
  const req = d2.args[0] as { owner: Address; tokens: Address[]; to: Address; relayerFeeBps: bigint; deadline: bigint; sig: Hex };
  const rec = await recoverTypedDataAddress({ domain: vaultClaimDomain(ACTIVE_CHAIN.id, VAULT), types: CLAIM_TYPES, primaryType: "Claim",
    message: { owner: req.owner, tokens: req.tokens, to: req.to, relayerFeeBps: req.relayerFeeBps, nonce: BigInt(3), deadline: req.deadline }, signature: req.sig });
  assert.equal(rec, owner);
  assert.equal(req.to, ME);
  // referral: FeeRouter part and vault part each get their own claim (vault settles nothing extra: [])
  const asset = { address: USDG, symbol: "USDG", decimals: 6, usd: 1 };
  const rc = referralClaimCalls([{ asset, claimable: BigInt(9), vault: VAULT, vaultClaimable: BigInt(4) }]);
  assert.deepEqual(rc.map((c) => c.to), [fr, VAULT]);
  assert.deepEqual(fn(rc[1], curveFeeVaultAbi).args, [USDG, []]);
  assert.deepEqual(referralClaimCalls([{ asset, claimable: BigInt(4), vault: VAULT, vaultClaimable: BigInt(4) }]).map((c) => c.to), [VAULT]);
  assert.deepEqual(referralClaimCalls([{ asset, claimable: BigInt(4) }]).map((c) => c.to), [fr]);
});

test("pool / burn coins show nothing to claim (the claim would revert) and say where the fees go", async () => {
  const { markRouted } = await import("../lib/claims/creatorFees");
  const asset = { address: A(5), symbol: "USDG", decimals: 6, usd: 1 } as never;
  const row = (token: `0x${string}`) => ({
    token, name: "R", ticker: "R", quote: asset, claimable: BigInt(9), claimed: BigInt(4), lifetime: BigInt(13), recent: [],
    tokenSide: { asset, claimable: BigInt(3), claimed: BigInt(0) }, vaultClaimable: BigInt(5), baseClaimable: BigInt(4),
  });
  const pc = { readContract: async ({ args }: { args: [string] }) => (args[0] === A(1) ? 1 : args[0] === A(2) ? 2 : 0) } as never;
  const [pool, burn, keep] = await markRouted(pc, [row(A(1)), row(A(2)), row(A(3))]);
  assert.equal(pool.routed, 1);
  assert.equal(burn.routed, 2);
  assert.equal(keep.routed, undefined);
  for (const r of [pool, burn]) {
    assert.equal(r.claimable, BigInt(0));
    assert.equal(r.baseClaimable, BigInt(0));
    assert.equal(r.vaultClaimable, BigInt(0));
    assert.equal(r.tokenSide?.claimable, BigInt(0));
    assert.equal(r.lifetime, r.claimed);
  }
  assert.equal(keep.claimable, BigInt(9));
});
