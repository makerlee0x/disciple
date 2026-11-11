import Link from "next/link";
import LostSky from "@/components/LostSky";

export default function NotFound() {
  return (
    <LostSky
      kicker="404"
      title="This rocket is off course."
      body="We couldn't find that page. Head back to the launchpad, or launch a rocket of your own."
    >
      <Link href="/" className="ds-btn gold">Launchpad</Link>
      <Link href="/create" className="ds-btn">Launch a Rocket</Link>
    </LostSky>
  );
}
