"use client";

import { useEffect } from "react";
import ProfileDashboard from "@/components/profile/ProfileDashboard";
import { normalizeUsername, rememberReferrer } from "@/lib/profile";

/** Public pilot profile; doubles as the referral landing (/u/name?ref=1 records the referrer once). */
export default function PublicProfile({ username }: { username: string }) {
  const u = normalizeUsername(username);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("ref")) rememberReferrer(u);
  }, [u]);
  return <ProfileDashboard mode="public" username={u} />;
}
