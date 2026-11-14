import { notFound } from "next/navigation";
import { CREW_ENABLED } from "@/lib/features";
import FlyLanding from "@/components/crew/FlyLanding";

export const metadata = { title: "Fly with me · DISCIPLE" };

/** /fly?u=<inviter>&c=<coin>: where /fly/<username>/<ticker> lands after setting the referral cookie. Read client side. */
export default function Page() {
  if (!CREW_ENABLED) notFound();
  return <FlyLanding />;
}
