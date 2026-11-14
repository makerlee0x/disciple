import FlyLanding from "@/components/crew/FlyLanding";

export const metadata = { title: "Fly with me · DISCIPLE" };

/** /fly?u=<inviter>&c=<coin>: where /fly/<username>/<ticker> lands after setting the referral cookie. Read client side. */
export default function Page() {
  return <FlyLanding />;
}
