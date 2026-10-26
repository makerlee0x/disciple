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
    <div role="status" data-testid="invite-banner" style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 60,
      display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", borderRadius: 12, background: "rgba(22,24,28,.96)", border: "1px solid var(--dsc-border)", color: "var(--dsc-text)", fontSize: 13 }}>
      <span>{C["gate.title"]} {C["gate.body"]}</span>
      <Link href="/invite" className="cl-btn sm primary">{C["gate.banner.link"]}</Link>
    </div>
  );
}
