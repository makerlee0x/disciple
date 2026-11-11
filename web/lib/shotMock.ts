/**
 * Dev/screenshot-only signed-in chrome. On only when NEXT_PUBLIC_SHOT_MOCK=1 (the shots script).
 * Never set this in Production or Preview deploys. Does not change the real login flow.
 */
export const SHOT_MOCK = process.env.NEXT_PUBLIC_SHOT_MOCK === "1";

export const SHOT_ACCOUNT = {
  address: "0x3DFE06e0854788EED40f852d097d3cF0337dBEDE",
  name: "makerlee",
  cashUsd: 1240.5,
  totalUsd: 3188.2,
  change24hUsd: 42.15,
} as const;
