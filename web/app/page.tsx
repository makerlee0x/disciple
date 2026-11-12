/**
 * App home = the lobby (brand v3 lobby mockup). Door one: LAUNCH A ROCKET on the night pad (HomeHero, a card about 3/4 of
 * the row). Beside it: JOIN A FLIGHT and today's missions. Then the shelves (Climbing now, About to reach orbit, Fresh off
 * the pad), every rocket (Launchpad, lazy) and the four steps. Server-rendered with live data (lib/server/home: chain
 * launches + indexed trades), regenerated every 30s, so the sky plate and the lobby numbers paint from the first HTML.
 */
import HomeHero from "@/components/home/HomeHero";
import HomeFeedLazy from "@/components/home/HomeFeedLazy";
import Lobby, { LobbySteps } from "@/components/home/Lobby";
import { getHomeData } from "@/lib/server/home";
import s from "@/components/home/lobby.module.css";

export const revalidate = 30;

export default async function HomePage() {
  const data = await getHomeData();
  return (
    <div className={s.page}>
      <Lobby initial={data} hero={<HomeHero key="hero" data={data} />} />
      {data.coins.length > 0 && <HomeFeedLazy initial={data.coins} />}
      <LobbySteps />
    </div>
  );
}
