// Username / profile identity: gasless Preview must key claims to the smart account, not the Privy EOA.
//   tsx --test scripts/test-profile-identity.mts
import test from "node:test";
import assert from "node:assert/strict";
import { profileIdentityAddress } from "../lib/profileIdentity.ts";

// lee's wallets from the gasless Preview report (shared KV stores @maker on the smart account).
const EOA = "0x6db02c11d1fdf6b60b5796dff0285dd71dfad9a3";
const SMART = "0x3dfe06e0854788eed40f852d097d3cf0337dbede";
const OTHER = "0x" + "1".repeat(40);

test("gasless: connected owner EOA maps to the counterfactual smart account", () => {
  assert.equal(profileIdentityAddress({ connected: EOA, smartAccount: SMART, owner: EOA }), SMART);
  assert.equal(profileIdentityAddress({ connected: EOA.toUpperCase().replace("0X", "0x"), smartAccount: SMART, owner: EOA }), SMART);
});

test("production: connected smart account stays the smart account", () => {
  assert.equal(profileIdentityAddress({ connected: SMART, smartAccount: SMART, owner: EOA }), SMART);
});

test("plain wallet / signed out: no smart account ⇒ the connected address is unchanged", () => {
  assert.equal(profileIdentityAddress({ connected: EOA, smartAccount: null, owner: null }), EOA);
  assert.equal(profileIdentityAddress({ connected: null, smartAccount: SMART, owner: EOA }), null);
  assert.equal(profileIdentityAddress({}), null);
});

test("someone else's address is not remapped to this session's smart account", () => {
  assert.equal(profileIdentityAddress({ connected: OTHER, smartAccount: SMART, owner: EOA }), OTHER);
});

test("invalid addresses are ignored", () => {
  assert.equal(profileIdentityAddress({ connected: "maker", smartAccount: SMART, owner: EOA }), null);
  assert.equal(profileIdentityAddress({ connected: EOA, smartAccount: "0xnope", owner: EOA }), EOA);
});
