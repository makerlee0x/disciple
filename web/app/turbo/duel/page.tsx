"use client";
/**
 * /turbo/duel: Trading Duel (hidden with the rest of Turbo: /turbo?turbo=1 on this device, and the Turbo password).
 *
 * A friend's duel link (?c=CODE, from /vs/<pilot> or a shared invite) opened by someone who has never signed in on this
 * device goes to /duel with the same query, where they join as a guest pilot right away. Here the join waited for a
 * sign-in, so the most viral path had a signup wall before the first match (first 60 seconds pass, maker 2026-11-21).
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { isTurboEnabled } from "@/lib/turbo/flag";
import { hasSavedSession } from "@/lib/aa/sessionState";
import { guestJoinPath } from "@/lib/duel/guestJoin";
import { captureRefFromCookie, captureRefFromQuery } from "@/lib/referral";
import { withBase } from "@/lib/base-path";

const DuelScreen = dynamic(() => import("@/components/turbo/duel/DuelScreen"), { ssr: false });

export default function DuelPage() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    const to = guestJoinPath(location.search, hasSavedSession());
    if (to) {
      // /duel has no app shell, so the challenger's ?ref= is kept here first (first touch wins, as everywhere)
      captureRefFromCookie(); captureRefFromQuery(location.search);
      location.replace(withBase(to)); return;
    }
    setOn(isTurboEnabled());
  }, []);
  if (!on) return null;
  return <DuelScreen />;
}
