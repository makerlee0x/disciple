/** Deployment-selected mode. A possibly sent operation never switches transport automatically. */
/** "gasless" (flow/gasless-permit2): Privy EOA signs a Permit2 witness, our relayer EOA calls the gasless router directly
 *  (lib/server/gaslessRelay). This is the default in EVERY environment, including production. Explicit leftover
 *  self/bso/hosted values are still recognized by the switch until those paths are removed. */
export type SponsorshipMode = "self" | "bso" | "hosted" | "gasless";
type ModeEnv = { [key: string]: string | undefined; GAS_SPONSORSHIP_MODE?: string; NEXT_PUBLIC_GAS_SPONSORSHIP_MODE?: string; AA_SELF_BUNDLER?: string; VERCEL_ENV?: string; NEXT_PUBLIC_VERCEL_ENV?: string };
export function resolveSponsorshipMode(_env: ModeEnv): SponsorshipMode {
  // Leftover explicit self/bso/hosted values map to gasless so a stale env cannot select a deleted 4337 path.
  // The switch is kept; gasless is the only resolved mode in every environment, including production.
  return "gasless";
}
export const serverSponsorshipMode = () => resolveSponsorshipMode(process.env);
export const selfBundlerMode = () => serverSponsorshipMode() === "self";
export const gaslessMode = () => serverSponsorshipMode() === "gasless";
export const SPONSORSHIP_CONFIG_ID = "disciple-aa-config";
/** Only a non-secret enum + chain ID is published by the server; never export AA/server credentials. */
export function clientSponsorshipMode(): SponsorshipMode {
  if (typeof document !== "undefined") {
    try {
      const raw = document.getElementById(SPONSORSHIP_CONFIG_ID)?.textContent;
      const config = raw ? JSON.parse(raw) as { chainId?: unknown; mode?: unknown } : undefined;
      if (typeof config?.chainId === "number" && (config.mode === "self" || config.mode === "bso" || config.mode === "hosted" || config.mode === "gasless")) return "gasless";
    } catch { /* malformed / absent bootstrap → default gasless */ }
    return "gasless";
  }
  return resolveSponsorshipMode({ NEXT_PUBLIC_GAS_SPONSORSHIP_MODE: process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE, NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV });
}
export const clientSelfBundlerMode = () => clientSponsorshipMode() === "self";
export const clientGaslessMode = () => clientSponsorshipMode() === "gasless";
/** 4337 sign-in warm-ups (gas reserve, paymaster prepay, auto one-tap). False in gasless mode so /api/paymaster is not called. */
export function shouldWarmAaOnSessionStart(mode: SponsorshipMode = clientSponsorshipMode()): boolean {
  return mode !== "gasless";
}
