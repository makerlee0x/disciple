import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Custody executor (launch). FLOW model: user approves once at deposit, the platform submits
 * trades without per-trade signatures.
 * TODO(FLOW): flow/contracts-v0 ships no deposit vault / sellFor / operator role
 * (BondingCurve.buyFor is Launchpad-only), so there is nothing safe to relay to yet.
 * Wire this to the vault + a KMS-held executor key once FLOW adds it. Never put a key in env for the browser.
 */
export async function POST() {
  return NextResponse.json(
    { code: "ExecutorNotDeployed", error: "Trading opens soon: the custody vault isn't deployed yet." },
    { status: 501 },
  );
}
