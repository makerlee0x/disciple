/**
 * Flight game module.
 * Runtime engine lives at /public/flight/engine.js (faithful port of prototype/game.html).
 * Shared ladder / modes / bomb config: @/lib/config
 * Protocol stubs for contracts: @/lib/protocol
 */
export {
  TIERS,
  MODES,
  BOMB_PCT,
  BOMB_TIERS,
  CURVE,
  CHAIN,
  DEMO_POOL,
  GAS,
  minShotUsd,
  fmtUsd,
} from "../config";
export { graduationPct as gradProgress } from "../mcap";
