// Sign-in methods (lee 2026-10-29): email, Google, X/Twitter and external wallets. An external wallet is only the
// login: every player gets an embedded wallet, which owns the smart account (one-tap signs the same for everyone).
//   pnpm test:login-methods   (pure: reads the Privy config source, no Privy SDK)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERIFIED_LOGIN_TYPES, isLoginVerified } from "../lib/pveAttest";

const mount = readFileSync(new URL("../components/PrivyMount.tsx", import.meta.url), "utf8");

test("Privy config: email, Google, X/Twitter and external wallet sign-in", () => {
  const m = mount.match(/loginMethods:\s*\[([^\]]*)\]/);
  assert.ok(m, "loginMethods present");
  const methods = m![1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean);
  assert.deepEqual(methods.sort(), ["email", "google", "twitter", "wallet"]);
});

test("Privy config: every player gets an embedded wallet (it owns the smart account), external-wallet logins too", () => {
  assert.match(mount, /createOnLogin:\s*"all-users"/);
  assert.match(mount, /walletClientType === "privy"/, "the embedded wallet is the smart-account owner, never the external one");
});

test("PVE login-verified: X counts like email / Google; a wallet-only login does not", () => {
  assert.ok(VERIFIED_LOGIN_TYPES.has("twitter_oauth"));
  assert.equal(isLoginVerified({ id: "did:privy:x", linked_accounts: [{ type: "twitter_oauth" } as never] }), true);
  assert.equal(isLoginVerified({ id: "did:privy:w", linked_accounts: [{ type: "wallet", address: "0x" + "1".repeat(40) } as never] }), false);
});
