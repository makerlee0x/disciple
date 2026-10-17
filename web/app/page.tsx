/**
 * App home (lee via BRAND, Oct 17 2026: visitors land straight in the app, no marketing landing).
 * Trending hero (#1 by 24h volume, fixed for the visit) + the feed (Launchpad, New sort, lazy).
 * Server-rendered with live data (lib/server/home: chain launches + indexed trades), regenerated every 30s, so the
 * hero and its single sky plate paint from the first HTML. The retired #79 rooftop hero is components/home/RooftopHome.
 */
import HomeHero from "@/components/home/HomeHero";
import HomeFeedLazy from "@/components/home/HomeFeedLazy";
import { getHomeData } from "@/lib/server/home";

export const revalidate = 30;

export default async function HomePage() {
  const data = await getHomeData();
  return (
    <>
      <HomeHero data={data} />
      <HomeFeedLazy initial={data.coins} />
    </>
  );
}
