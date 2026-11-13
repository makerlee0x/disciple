"use client";
/** Thin banner for signed-in players who aren't in yet, while invite-only is on. Never shown on game routes. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { INVITE_COPY as C } from "@/lib/copy/invites";
import { useInvites } from "./useInvites";

export default function InviteBanner() {
  const path = usePathname() || "/";
  const { st } = useInvites();
  if (!st?.mode || !st.signedIn || st.in || path.startsWith("/invite") || path.startsWith("/admin")) return null;
  return (
    <div role="status" data-testid="invite-banner" className="wb-invite">
      <span>{C["gate.banner.text"]}</span>
      <Link href="/invite" className="cl-btn sm primary">{C["gate.banner.link"]}</Link>
    </div>
  );
}
