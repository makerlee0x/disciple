// Sign-in methods (lee 2026-10-29): email, Google, X/Twitter and external wallets. An external wallet is only the
// login: every player gets an embedded wallet, which owns the smart account (one-tap signs the same for everyone).
//   pnpm test:login-methods   (pure: reads the Privy config source, no Privy SDK)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERIFIED_LOGIN_TYPES, isLoginVerified } from "../lib/pveAttest";
import { needsEmbeddedWallet, ownerWalletAddress } from "../lib/privyOwner";

const mount = readFileSync(new URL("../components/PrivyMount.tsx", import.meta.url), "utf8");

test("Privy config: email, Google, X/Twitter and external wallet sign-in", () => {
  const m = mount.match(/loginMethods:\s*\[([^\]]*)\]/);
  assert.ok(m, "loginMethods present");
  const methods = m![1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean);
  assert.deepEqual(methods.sort(), ["email", "google", "twitter", "wallet"]);
});

test("Privy config: ONE embedded wallet per user (it owns the smart account), external-wallet logins too", () => {
  assert.match(mount, /createOnLogin:\s*"users-without-wallets"/, "never a second embedded wallet for a returning user (lee, Oct 30)");
  assert.match(mount, /needsEmbeddedWallet\(/, "an external-wallet-only login still gets one (created only when none exists)");
  assert.match(mount, /walletClientType === "privy"/, "the embedded wallet is the smart-account owner, never the external one");
  assert.match(mount, /ownerWalletAddress\(/, "owner = the user's original embedded wallet");
});

test("owner pick: the ORIGINAL embedded wallet (HD index 0, then earliest), never an external or newer one", () => {
  const old = "0x" + "a".repeat(40), neu = "0x" + "b".repeat(40), ext = "0x" + "c".repeat(40);
  const linked = [
    { type: "wallet", address: ext, chainType: "ethereum", walletClientType: "metamask", firstVerifiedAt: "2026-01-01" },
    { type: "wallet", address: neu, chainType: "ethereum", walletClientType: "privy", walletIndex: 1, firstVerifiedAt: "2026-10-30" },
    { type: "twitter_oauth" },
    { type: "wallet", address: old.toUpperCase().replace("0X", "0x"), chainType: "ethereum", walletClientType: "privy", walletIndex: 0, firstVerifiedAt: "2026-10-20" },
  ];
  assert.equal(ownerWalletAddress(linked), old);
  assert.equal(ownerWalletAddress([linked[1], { ...linked[3], walletIndex: null, firstVerifiedAt: "2026-10-20" }].map((x) => ({ ...x, walletIndex: null }))), old, "no index ⇒ earliest linked");
  assert.equal(needsEmbeddedWallet([linked[0]]), true, "external-only login ⇒ create one");
  assert.equal(needsEmbeddedWallet(linked), false);
  assert.equal(ownerWalletAddress([]), null);
});

test("PVE login-verified: X counts like email / Google; a wallet-only login does not", () => {
  assert.ok(VERIFIED_LOGIN_TYPES.has("twitter_oauth"));
  assert.equal(isLoginVerified({ id: "did:privy:x", linked_accounts: [{ type: "twitter_oauth" } as never] }), true);
  assert.equal(isLoginVerified({ id: "did:privy:w", linked_accounts: [{ type: "wallet", address: "0x" + "1".repeat(40) } as never] }), false);
});
