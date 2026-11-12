import type { Metadata } from "next";
import LookdevStudio from "@/components/flight/LookdevStudio";

/** /flight/lookdev — internal rocket look-dev studio (STEP 1 of the 3D flight work). Not linked from the nav, not part of
 *  the coin / trade screen. Query params are documented in lib/flight/lookdev/studio.ts. */
export const metadata: Metadata = { title: "DISCIPLE — rocket look-dev", robots: { index: false, follow: false } };

export default function LookdevPage() {
  return <LookdevStudio />;
}
