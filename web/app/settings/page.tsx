"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Settings moved under the private profile. */
export default function SettingsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/profile#settings"); }, [router]);
  return <div className="page-shell"><p className="note">Settings live on your profile now — redirecting…</p></div>;
}
