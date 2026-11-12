/**
 * App home = the lobby (brand v3). Door one: LAUNCH A ROCKET on the night pad (HomeHero). Door two: JOIN A FLIGHT beside
 * today's missions, then the shelves (Climbing now, About to reach orbit, Fresh off the pad), every rocket (Launchpad,
 * lazy) and the four steps. Server-rendered with live data (lib/server/home: chain launches + indexed trades),
 * regenerated every 30s, so the hero's sky plate and the lobby numbers paint from the first HTML.
 */
import HomeHero from "@/components/home/HomeHero";
import HomeFeedLazy from "@/components/home/HomeFeedLazy";
import Lobby, { LobbySteps } from "@/components/home/Lobby";
import { getHomeData } from "@/lib/server/home";

export const revalidate = 30;

export default async function HomePage() {
  const data = await getHomeData();
  return (
    <>
      <HomeHero data={data} />
      <Lobby initial={data} />
      {data.coins.length > 0 && <HomeFeedLazy initial={data.coins} />}
      <LobbySteps />
    </>
  );
}
