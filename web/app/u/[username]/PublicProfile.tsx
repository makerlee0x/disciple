"use client";

import { useEffect } from "react";
import ProfileDashboard from "@/components/profile/ProfileDashboard";
import { normalizeUsername, rememberReferrer } from "@/lib/profile";
import { rememberRefTouch } from "@/lib/referral";

/** Public pilot profile; doubles as the referral landing (legacy /u/name?ref=1 still records the referrer once; new links are /r/<name>). */
export default function PublicProfile({ username }: { username: string }) {
  const u = normalizeUsername(username);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("ref")) return;
    rememberReferrer(u);
    fetch(`/api/profile/username?resolve=${encodeURIComponent(u)}`).then((r) => r.json())
      .then((j: { address?: string | null }) => rememberRefTouch({ u, a: j.address ?? null }))
      .catch(() => rememberRefTouch({ u, a: null }));
  }, [u]);
  return <ProfileDashboard mode="public" username={u} />;
}
