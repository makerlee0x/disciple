// Unit tests for the PVE login attestation (lib/pveAttest, lib/pve) — pure: throwaway keys, fake JWKS/Privy/RPC.
//   pnpm test:pve-attest
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import { decodeFunctionData, recoverTypedDataAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AuthError, LOGIN_TYPES, MAX_TTL_SEC, attestTtl, attesterAccount, isLoginVerified, signLoginAttestation,
  verifyPrivyAccessToken, walletBelongsTo, type PrivyUser,
} from "../lib/pveAttest";
import { ensurePveLogin, PveError, _resetPveCache } from "../lib/pve";
import { loginGateAbi } from "../lib/abi";

const APP = "app-test-123";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" } as never;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function jwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: "k1" }, key = privateKey) {
  const h = b64u(JSON.stringify(header)), p = b64u(JSON.stringify(payload));
  const sig = cryptoSign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}
const now = 1_800_000_000;
const good = { iss: "privy.io", aud: APP, sub: "did:privy:abc", sid: "s1", iat: now - 10, exp: now + 3600 };
const jwks = async () => [jwk];
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof AuthError && e.code === c);

test("Privy access token: valid ES256 token verifies; claims returned", async () => {
  const c = await verifyPrivyAccessToken(jwt(good), APP, jwks, now);
  assert.equal(c.userId, "did:privy:abc"); assert.equal(c.sessionId, "s1");
});
test("Privy access token: wrong aud / iss / expired / alg / tampered / foreign key / bad sub are rejected", async () => {
  await code(verifyPrivyAccessToken(jwt({ ...good, aud: "other" }), APP, jwks, now), "bad_audience");
  await code(verifyPrivyAccessToken(jwt({ ...good, iss: "evil" }), APP, jwks, now), "bad_issuer");
  await code(verifyPrivyAccessToken(jwt({ ...good, exp: now - 120 }), APP, jwks, now), "expired");
  await code(verifyPrivyAccessToken(jwt(good, { alg: "HS256", kid: "k1" }), APP, jwks, now), "bad_alg");
  const t = jwt(good).split("."); t[1] = b64u(JSON.stringify({ ...good, sub: "did:privy:victim" }));
  await code(verifyPrivyAccessToken(t.join("."), APP, jwks, now), "bad_signature");
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  await code(verifyPrivyAccessToken(jwt(good, undefined, other), APP, jwks, now), "bad_signature");
  await code(verifyPrivyAccessToken(jwt({ ...good, sub: "0xabc" }), APP, jwks, now), "bad_subject");
  await code(verifyPrivyAccessToken("nope", APP, jwks, now), "bad_token");
  await code(verifyPrivyAccessToken(jwt(good), "", jwks, now), "privy_not_configured");
});

test("attester: fails closed without a key; TTL clamped under LoginGate.MAX_TTL (24h)", () => {
  assert.equal(attesterAccount({}), null);
  assert.equal(attesterAccount({ PVE_ATTESTER_PRIVATE_KEY: "0x1234" }), null);
  assert.ok(attesterAccount({ PVE_ATTESTER_PRIVATE_KEY: generatePrivateKey() }));
  assert.equal(attestTtl({ PVE_ATTEST_TTL_SEC: String(48 * 3600) }), MAX_TTL_SEC);
  assert.ok(attestTtl({}) <= MAX_TTL_SEC && MAX_TTL_SEC < 24 * 3600);
});

test("EIP-712 LoginAttestation{wallet,uint64 expiry,coin} under DisciplePVE v1 recovers to the attester", async () => {
  const acct = attesterAccount({ PVE_ATTESTER_PRIVATE_KEY: generatePrivateKey() })!;
  const msg = { wallet: "0x1111111111111111111111111111111111111111" as Address, expiry: now + 3600, coin: "0x0000000000000000000000000000000000000000" as Address };
  const gate = "0xe900b7060895f130e866eeddec2b3efd3ff0b69f" as Address;
  const sig = await signLoginAttestation(acct, { ...msg, chainId: 46630, loginGate: gate });
  const rec = await recoverTypedDataAddress({ domain: { name: "DisciplePVE", version: "1", chainId: 46630, verifyingContract: gate }, types: LOGIN_TYPES, primaryType: "LoginAttestation", message: { ...msg, expiry: BigInt(msg.expiry) }, signature: sig });
  assert.equal(rec, acct.address);
  const recWrongChain = await recoverTypedDataAddress({ domain: { name: "DisciplePVE", version: "1", chainId: 1, verifyingContract: gate }, types: LOGIN_TYPES, primaryType: "LoginAttestation", message: { ...msg, expiry: BigInt(msg.expiry) }, signature: sig });
  assert.notEqual(recWrongChain, acct.address);
});

test("login-verified = email / Google / X linked; wallet ownership = linked EOA or its smart account", async () => {
  const eoa = privateKeyToAccount(generatePrivateKey()).address;
  const smart = "0x2222222222222222222222222222222222222222";
  const u: PrivyUser = { id: "did:privy:abc", linked_accounts: [{ type: "wallet", address: eoa, wallet_client_type: "privy", chain_type: "ethereum" }, { type: "email" }] };
  assert.equal(isLoginVerified(u), true);
  assert.equal(isLoginVerified({ id: "x", linked_accounts: [{ type: "wallet", address: eoa }] }), false);
  assert.equal(isLoginVerified({ id: "x", linked_accounts: [{ type: "twitter_oauth" }] }), true);
  const predict = async (o: Address) => (o.toLowerCase() === eoa.toLowerCase() ? [smart, null] : [null, null]);
  assert.equal(await walletBelongsTo(u, eoa, predict), true);
  assert.equal(await walletBelongsTo(u, smart, predict), true);
  assert.equal(await walletBelongsTo(u, "0x3333333333333333333333333333333333333333", predict), false);
});

test("client ensurePveLogin: verified ⇒ no calls; relayed ⇒ no calls; relay down ⇒ prepend LoginGate.attest; no login ⇒ PveError", async () => {
  const me = "0x4444444444444444444444444444444444444444" as Address;
  const sec = () => Math.floor(Date.now() / 1000);
  const pc = (until: number) => ({ readContract: async () => BigInt(until) }) as never;
  _resetPveCache();
  assert.deepEqual(await ensurePveLogin(pc(sec() + 3600), me), []);
  _resetPveCache();
  const fetchRelayed = (async () => new Response(JSON.stringify({ signature: "0x01", expiry: sec() + 3600, coin: "0x0000000000000000000000000000000000000000", relayed: true }))) as typeof fetch;
  assert.deepEqual(await ensurePveLogin(pc(0), me, { fetchFn: fetchRelayed, token: async () => "t" }), []);
  _resetPveCache();
  const sig = `0x${"ab".repeat(65)}`, exp = sec() + 3600;
  const fetchSig = (async () => new Response(JSON.stringify({ signature: sig, expiry: exp, coin: "0x0000000000000000000000000000000000000000", relayed: false }))) as typeof fetch;
  const calls = await ensurePveLogin(pc(0), me, { fetchFn: fetchSig, token: async () => "t" });
  assert.equal(calls.length, 1);
  const d = decodeFunctionData({ abi: loginGateAbi, data: calls[0].data });
  assert.equal(d.functionName, "attest"); assert.equal((d.args as unknown[])[0], me); assert.equal((d.args as unknown[])[1], BigInt(exp));
  _resetPveCache();
  await assert.rejects(ensurePveLogin(pc(0), me, { token: async () => null }), (e: unknown) => e instanceof PveError && e.code === "PveLoginRequired");
  const fetch403 = (async () => new Response(JSON.stringify({ error: "login_not_verified" }), { status: 403 })) as typeof fetch;
  await assert.rejects(ensurePveLogin(pc(0), me, { fetchFn: fetch403, token: async () => "t" }), (e: unknown) => e instanceof PveError && /Sign in with X, email or wallet/.test(e.message));
});
