"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Wallet / deposit moved under the private profile (Cash panel). */
export default function WalletRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/profile#cash"); }, [router]);
  return <div className="page-shell"><p className="note">Deposit &amp; withdraw live on your profile now — redirecting…</p></div>;
}
