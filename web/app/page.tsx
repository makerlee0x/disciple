/**
 * App home = the lobby (brand v3 lobby mockup). Door one: LAUNCH A ROCKET on the night pad (HomeHero, a card about 3/4 of
 * the row). Beside it: JOIN A FLIGHT and today's missions. Then the shelves (Climbing now, About to reach orbit, Fresh off
 * the pad), every rocket (Launchpad, lazy) and the four steps. Server-rendered with live data (lib/server/home: chain
 * launches + indexed trades), regenerated every 30s, so the sky plate and the lobby numbers paint from the first HTML.
 * Signed-out visitors get the landing lobby instead (LobbySignedOut: lift-off hero, ticker, How it plays, Flying now,
 * Top pilots, Launch your own); HomeGate picks one before paint. Every rocket sits below both.
 */
import ModeSelect from "@/components/home/ModeSelect";
import HomeFeedLazy from "@/components/home/HomeFeedLazy";
import Lobby, { LobbySteps } from "@/components/home/Lobby";
import LobbySignedOut from "@/components/home/LobbySignedOut";
import HomeGate from "@/components/home/HomeGate";
import { getHomeData } from "@/lib/server/home";
import s from "@/components/home/lobby.module.css";

export const revalidate = 30;

export default async function HomePage() {
  const data = await getHomeData();
  return (
    <div className={s.page}>
      <HomeGate
        signedIn={<Lobby initial={data} hero={<ModeSelect key="modes" signedIn flying={data.coins.filter((c) => !c.graduated).length} />} />}
        signedOut={<LobbySignedOut initial={data} />}
      />
      {data.coins.length > 0 && <HomeFeedLazy initial={data.coins} />}
      <HomeGate signedIn={<LobbySteps />} signedOut={null} />
    </div>
  );
}
