import InvitePanel from "@/components/invites/InvitePanel";
import { cardMeta } from "@/lib/ogMeta";

export const metadata = cardMeta("You're invited to DISCIPLE", "Take your seat and boost your first rocket.", "/api/og/invite", "A seat on the rocket");
export default function Page() {
  return <InvitePanel />;
}
