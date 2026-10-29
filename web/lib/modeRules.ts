/**
 * Launch modes (mode rules v2): ONE shared source for every cap the site shows. Mirrors what the contracts enforce:
 *   contracts/src/libraries/Constants.sol  MODE_* ids, PVE/PVP_CAP_START/END_BPS, FIRST_BOOST_MAX_BPS_PVE/PVP,
 *                                          START_MCAP_USD → GRADUATION_MCAP_USD
 *   BondingCurve.netCapNow()               holding cap, linear in mcap between the two endpoints (curve only)
 *   Launchpad.firstBoostMaxBps(mode)       Easy 1.2%, Hard 3.33%, Trench = live creatorBuyMaxBps (owner-settable)
 * scripts/test-mode-rules.mjs parses Constants.sol and fails if these drift. No imports (unit-tested offline).
 * Live per-coin values (HUD rules line) still come from the coin itself (lib/flight/coinRules: netCapNow()).
 */

/** On-chain mode ids (Constants.MODE_*): 0 TRENCH, 1 PVE = Easy, 2 PVP = Hard. Immutable per coin. */
export const MODE = { TRENCH: 0, EASY: 1, HARD: 2 } as const;
export type ModeId = (typeof MODE)[keyof typeof MODE];

/** Player-facing names. */
export const MODE_LABEL: Record<number, string> = { [MODE.TRENCH]: "Trench", [MODE.EASY]: "Easy", [MODE.HARD]: "Hard" };

/** The mode a new launch starts on (lee, 2026-10-26: Easy is the default). */
export const DEFAULT_MODE: ModeId = MODE.EASY;

/** Order on the create page. */
export const MODE_ORDER: readonly ModeId[] = [MODE.EASY, MODE.HARD, MODE.TRENCH];

/** Curve mcap range the holding cap grows over (Constants.START_MCAP_USD / GRADUATION_MCAP_USD). */
export const CAP_MCAP_START_USD = 3_333;
export const CAP_MCAP_END_USD = 33_333;

/** Per-wallet holding cap in bps of supply: start at $3,333 → end at $33,333. null = no mode cap (Trench). */
export const HOLDING_CAP_BPS: Record<number, { start: number; end: number } | null> = {
  [MODE.EASY]: { start: 100, end: 333 },   // PVE_CAP_START_BPS / PVE_CAP_END_BPS
  [MODE.HARD]: { start: 333, end: 777 },   // PVP_CAP_START_BPS / PVP_CAP_END_BPS
  [MODE.TRENCH]: null,
};

/** First BOOST (creator launch buy) max in bps of supply. null = Launchpad.creatorBuyMaxBps() (read live). */
export const FIRST_BOOST_MAX_BPS: Record<number, number | null> = {
  [MODE.EASY]: 120,   // FIRST_BOOST_MAX_BPS_PVE, locked until graduation
  [MODE.HARD]: 333,   // FIRST_BOOST_MAX_BPS_PVP
  [MODE.TRENCH]: null,
};

/** bps → "3.33%" (at most 2 decimals, no trailing zeros). */
export const pctOf = (bps: number) => `${+(bps / 100).toFixed(2)}%`;

/** "1% → 3.33%" or null when the mode has no cap. */
export function holdingCapRange(mode: number): string | null {
  const c = HOLDING_CAP_BPS[mode];
  return c ? `${pctOf(c.start)} → ${pctOf(c.end)}` : null;
}

const capLine = (m: number) => {
  const c = HOLDING_CAP_BPS[m]!;
  return `Each wallet can hold up to ${pctOf(c.start)} of supply, rising to ${pctOf(c.end)} as the rocket climbs.`;
};

/**
 * Create-page copy (BRAND r1, /workspace/disciple-brand/copy/r1/create-modes.md). DRAFT, pending lee's approval.
 * Cap numbers are filled in from HOLDING_CAP_BPS so the words can never drift from the constant.
 */
export const MODE_COPY: Record<number, string> = {
  [MODE.EASY]: capLine(MODE.EASY),
  [MODE.HARD]: capLine(MODE.HARD),
  [MODE.TRENCH]: "No holding cap. Anything goes, except snipers still pay first.",
};
/** Extra line shown under the picker for the selected mode (BRAND r1). */
export const MODE_SELECTED_COPY: Record<number, string> = {
  [MODE.EASY]: "Easy needs a signed-in account to BOOST (a verified email, Google or X login). DUMPs are always open.",
  [MODE.HARD]: "No login check on BOOSTs.",
  [MODE.TRENCH]: "No caps, no login check, no training wheels.",
};
/** Chip on the default card. */
export const MODE_DEFAULT_CHIP = "RECOMMENDED";
/** Helper text under the picker (BRAND r1). */
export const MODE_HELPER =
  "Pick how your rocket's crew can fight. The mode is set at launch and can't be changed. It only applies on the curve: after graduation, every rocket trades the same.";
/** Tooltip on the GAME MODE label (BRAND r1). */
export const MODE_TOOLTIP =
  "Holding cap: the most one wallet can hold of a rocket while it's on the curve. On Easy and Hard the cap grows as the rocket climbs. If a BOOST would take you past it, it fills up to the cap and the rest comes back to you. Selling frees up room.";
