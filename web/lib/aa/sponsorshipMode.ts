/** Deployment-selected mode. A possibly sent operation never switches transport automatically. */
export type SponsorshipMode = "self" | "bso" | "hosted";
type ModeEnv = { [key: string]: string | undefined; GAS_SPONSORSHIP_MODE?: string; NEXT_PUBLIC_GAS_SPONSORSHIP_MODE?: string; AA_SELF_BUNDLER?: string; VERCEL_ENV?: string; NEXT_PUBLIC_VERCEL_ENV?: string };
export function resolveSponsorshipMode(env: ModeEnv): SponsorshipMode {
  if (env.VERCEL_ENV === "production" || env.NEXT_PUBLIC_VERCEL_ENV === "production") return "hosted";
  const mode = env.GAS_SPONSORSHIP_MODE || env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE;
  if (mode === "bso") return "bso"; // explicit fallback takes precedence over the legacy self switch
  if (env.AA_SELF_BUNDLER === "0" || (mode && mode !== "self")) return "hosted";
  // Restore the pre-#246 self trade default on this test branch. AA_SELF_BUNDLER=0 is an explicit off switch.
  return "self";
}
export const serverSponsorshipMode = () => resolveSponsorshipMode(process.env);
export const selfBundlerMode = () => serverSponsorshipMode() === "self";
export const SPONSORSHIP_CONFIG_ID = "disciple-aa-config";
/** Only a non-secret enum + chain ID is published by the server; never export AA/server credentials. */
export function clientSponsorshipMode(): SponsorshipMode {
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production") return "hosted";
  if (typeof document !== "undefined") {
    try {
      const raw = document.getElementById(SPONSORSHIP_CONFIG_ID)?.textContent;
      const config = raw ? JSON.parse(raw) as { chainId?: unknown; mode?: unknown } : undefined;
      if (config?.chainId === 46630 && (config.mode === "self" || config.mode === "bso" || config.mode === "hosted")) return config.mode;
    } catch { /* malformed / absent bootstrap never authorizes the self transport */ }
    return "hosted";
  }
  // Standalone SDK/test harnesses have no DOM bootstrap; keep their explicit public BSO opt-in working.
  return resolveSponsorshipMode({ NEXT_PUBLIC_GAS_SPONSORSHIP_MODE: process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE, NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV });
}
export const clientSelfBundlerMode = () => clientSponsorshipMode() === "self";
