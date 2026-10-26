"use client";
/** Profile → Invites. Shows only while invite-only is on and the player is in. */
import MyInvites from "./MyInvites";
import { useInvites } from "./useInvites";

export default function InvitesCard() {
  const { st } = useInvites();
  if (!st?.mode || !st.in) return null;
  return <section className="cl-card" style={{ padding: 22, margin: "18px 0" }} data-testid="profile-invites"><MyInvites codes={st.codes ?? []} /></section>;
}
