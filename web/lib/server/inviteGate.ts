import "server-only";
/**
 * Production wiring for lib/server/invites: Upstash KV, Privy env, on-chain smart-account lookups, and the route gates.
 * The gates read the switch (invite:mode in KV, else INVITE_ONLY, else OFF) through a 15 s per-lambda cache, so with
 * invite-only OFF a gated route costs at most one KV read per 15 s and nothing else.
 * If KV errors while invite-only is ON, the gate lets the request through and logs a warning: an outage of the invite
 * store must not stop trading (this is a beta gate, not a security boundary — the contracts are permissionless).
 */
import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "@/lib/aa/constants";
import { kv } from "./kv";
import { privyEnv, type PrivyUser } from "./privyAuth";
import { gateUser, gateWallet, readMode, type Deps, type Gate, type Mode } from "./invites";

const factoryAbi = parseAbi([
  "function getAddressSemiModular(address owner, uint256 salt) view returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
]);
const pc = () => createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });

export function inviteDeps(): Deps {
  return {
    store: kv(),
    privy: privyEnv(),
    adminEmails: process.env.ADMIN_EMAILS,
    envMode: process.env.INVITE_ONLY,
    // linked wallets + the MAv2 and LightAccount v2 smart accounts each owns (salt 0, as app/api/pve/attest)
    async accountsOf(u: PrivyUser) {
      const c = pc();
      const smart = await Promise.all(u.wallets.slice(0, 10).flatMap((w) => [
        c.readContract({ address: MAV2_FACTORY, abi: factoryAbi, functionName: "getAddressSemiModular", args: [w as Address, BigInt(0)] }).catch(() => null),
        c.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: factoryAbi, functionName: "getAddress", args: [w as Address, BigInt(0)] }).catch(() => null),
      ]));
      return [...u.wallets, ...smart.filter((x): x is Address => !!x).map((a) => a.toLowerCase())];
    },
  };
}

let cached: { m: Mode; at: number } | null = null;
async function mode(): Promise<Mode> {
  if (cached && Date.now() - cached.at < 15_000) return cached.m;
  const m = await readMode(kv(), process.env.INVITE_ONLY);
  cached = { m, at: Date.now() };
  return m;
}

/** Plain message players see when a gated action is refused. */
export const INVITE_REQUIRED_MESSAGE = "DISCIPLE is invite-only for now. Enter an invite code on the Invites page to play.";

async function run(what: string, f: (m: Mode) => Promise<Gate>): Promise<Gate> {
  try {
    const m = await mode();
    if (!m.on) return { ok: true };
    return await f(m);
  } catch (e) {
    console.warn(`[disciple] invite gate: store error on ${what}, letting the request through:`, (e as Error).message);
    return { ok: true };
  }
}
/** Gate by wallet / smart-account address (bundler, paymaster, drip, chat, username). */
export const requireInviteWallet = (addr: string, what: string) => run(what, (m) => gateWallet(kv(), m, addr));
/** Gate by Privy user id (pve/attest). */
export const requireInviteUser = (privyId: string, what: string) => run(what, (m) => gateUser(kv(), m, privyId));

/** Standard 403 body for plain JSON routes. */
export const inviteRequiredResponse = () => NextResponse.json({ ok: false, error: "invite_required", message: INVITE_REQUIRED_MESSAGE }, { status: 403 });
/** JSON-RPC error for bundler / paymaster. */
export const inviteRequiredRpc = (id: unknown) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32004, message: INVITE_REQUIRED_MESSAGE, data: "invite_required" } }, { status: 403 });
