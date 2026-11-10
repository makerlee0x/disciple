import "server-only";
/**
 * Referral attach on gasless trades (flow/gasless-withdraw Plan 1). Copied pattern: ReferralRegistry attestor
 * path (Audit #3) — the same tryAttribute(trader, referrer) a regular buy prepends when NEXT_PUBLIC_REFERRAL_ATTRIBUTE=1.
 *
 * The signed trade is unchanged. AFTER the trade response is scheduled (waitUntil / fire-and-forget; never awaited,
 * even on Vercel), and only if the player sent a first-touch referrer and relay:ref:{wallet} is not "done", a
 * DEDICATED attestor key (REFERRAL_ATTESTOR_PRIVATE_KEY) calls registry.tryAttribute. If the env var is unset the
 * attach is skipped (feature off by default). Never falls back to the trade relayer key. A failed attach never
 * fails, delays, or strikes a trade. Self-referral and first-touch stay enforced on-chain.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { waitUntilFn } from "./defer";
import { kv } from "./kv";

const KEY32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const registryAbi = parseAbi([
  "function tryAttribute(address wallet, address referrer) returns (bool)",
  "function isAttestor(address) view returns (bool)",
  "function owner() view returns (address)",
]);
export const REFERRAL_ATTESTOR_ENV = "REFERRAL_ATTESTOR_PRIVATE_KEY";
export const referralDoneKey = (wallet: string) => `relay:ref:${wallet.toLowerCase()}`;
export const REFERRAL_DONE = "done";
const isZero = (a: string) => /^0x0{40}$/i.test(a);
const asAddr = (v: unknown): Address | undefined =>
  (typeof v === "string" && ADDR.test(v) && !isZero(v)) ? v as Address : undefined;

/** Dedicated attestor key, or undefined when unset / malformed. Never the trade relayer key. */
export function referralAttestorKey(env: NodeJS.ProcessEnv = process.env): Hex | undefined {
  const k = (env[REFERRAL_ATTESTOR_ENV] || "").trim();
  return KEY32.test(k) ? k as Hex : undefined;
}
export function referralAttestorAddress(env: NodeJS.ProcessEnv = process.env): Address | undefined {
  const k = referralAttestorKey(env);
  return k ? privateKeyToAccount(k).address : undefined;
}

export type AttachResult = "off" | "skipped" | "attached" | "failed";
export type AttachOpts = {
  trader: Address;
  referrer?: unknown;
  alreadyDone?: string | null;
  /** Injected in tests. Production reads REFERRAL_ATTESTOR_PRIVATE_KEY. */
  key?: Hex | undefined;
  send?: (to: Address, data: Hex, key: Hex) => Promise<{ ok: boolean; selector?: string }>;
  markDone?: (wallet: string) => Promise<void>;
};

/** On-chain reverts that mean "do not retry" — first-touch / self-referral already settled. */
const alreadySettled = (e: { selector?: string; message?: string; ok?: boolean }) =>
  /AlreadyAttributed|SelfReferral/i.test(e.message ?? e.selector ?? "");

async function defaultSend(to: Address, data: Hex, key: Hex): Promise<{ ok: boolean; message?: string }> {
  const account = privateKeyToAccount(key);
  const wc = createWalletClient({ account, chain: robinhoodTestnet, transport: http(undefined, { timeout: 20_000, retryCount: 1 }) });
  const hash = await wc.sendTransaction({ to, data, gas: 80_000n, chain: robinhoodTestnet });
  const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { timeout: 20_000, retryCount: 1 }) });
  const rc = await pc.waitForTransactionReceipt({ hash });
  return { ok: rc.status === "success" };
}

async function defaultMarkDone(wallet: string) {
  await kv().set(referralDoneKey(wallet), REFERRAL_DONE);
}

/**
 * One background tryAttribute. Never throws. Writes relay:ref:{wallet}=done only after a successful call or an
 * on-chain first-touch / self-referral rejection (retrying would revert forever).
 */
export async function attachReferral(o: AttachOpts): Promise<AttachResult> {
  try {
    const key = o.key !== undefined ? o.key : referralAttestorKey();
    if (!key) return "off";
    if (o.alreadyDone === REFERRAL_DONE) return "skipped";
    const trader = asAddr(o.trader), ref = asAddr(o.referrer);
    if (!trader || !ref) return "skipped";
    if (trader.toLowerCase() === ref.toLowerCase()) return "skipped";
    const registry = DEPLOYMENTS[46630].referralRegistry;
    if (!registry || isZero(registry)) return "skipped";
    const data = encodeFunctionData({ abi: registryAbi, functionName: "tryAttribute", args: [trader, ref] });
    const send = o.send ?? defaultSend;
    const res = await send(registry, data, key);
    if (!res.ok && !alreadySettled(res)) return "failed";
    await (o.markDone ?? defaultMarkDone)(trader).catch(() => undefined);
    return "attached";
  } catch (e) {
    if (alreadySettled(e as { message?: string })) {
      const trader = asAddr(o.trader);
      if (trader) await (o.markDone ?? defaultMarkDone)(trader).catch(() => undefined);
      return "attached";
    }
    return "failed";
  }
}

/** Schedule work after the response: waitUntil when present, otherwise fire-and-forget. NEVER awaits the task. */
export function afterTrade(task: () => Promise<unknown>, g: unknown = globalThis): void {
  const run = () => Promise.resolve().then(task).catch(() => undefined);
  const wu = waitUntilFn(g);
  if (wu) { wu(run()); return; }
  void run();
}

/** Referrer field on the unsigned gasless JSON body (not part of the Permit2 witness). */
export function referrerFromRaw(raw: unknown): Address | undefined {
  const r = (raw as { referrer?: unknown } | null)?.referrer;
  return asAddr(r);
}

export const gaslessReferralHooks = {
  after: afterTrade,
  attach: attachReferral,
};
