"use client";
/**
 * Privy = auth + embedded EOA custody only (owner of the user's Alchemy MAv2, lib/aa/session.ts).
 * @privy-io/react-auth is lazy-loaded into its own chunk (PrivyMount) so it is NOT in any page's first-load JS,
 * and is never fetched when Privy is off (no app id / NEXT_PUBLIC_AA_SIGNER=local). Children render immediately;
 * the login modal portals itself, and WalletButton reaches it through registerPrivy()/privyLogin().
 */
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { PRIVY_APP_ID, SIGNER_MODE } from "@/lib/aa/env"; // not lib/aa/session: that would put viem + noble in every page's first-load JS

const PrivyMount = dynamic(() => import("./PrivyMount"), { ssr: false });

export default function PrivyProviders({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      {PRIVY_APP_ID && SIGNER_MODE === "privy" ? <PrivyMount /> : null}
    </>
  );
}
