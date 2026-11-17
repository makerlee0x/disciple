/**
 * /live: Live flights, the top bar tab and the lobby's Live flights card (maker 2026-11-16: "live flights really should
 * just redirect to the All rockets list (not a random rocket)"). The same All rockets grid as the lobby foot (RocketGrid,
 * sort chips Newest / Climbing / Busiest / …), on its own page. Play now (/play) still drops you straight into the hottest one.
 */
import Link from "next/link";
import RocketGrid from "@/components/home/RocketGrid";
import { getHomeData } from "@/lib/server/home";
import s from "@/components/home/lobby.module.css";
import f from "@/components/home/appHome.module.css";
import st from "./flights.module.css";

export const revalidate = 30;
export const metadata = { title: "Live flights · DISCIPLE" };

export default async function FlightsPage() {
  const data = await getHomeData();
  const live = data.coins.filter((c) => !c.graduated).length;
  return (
    <div className={s.page}>
      <header className={st.hd}>
        <h1 className={st.h1}>Live flights</h1>
        <p className={st.sub}>{live > 0 ? `${live} ${live === 1 ? "rocket" : "rockets"} flying now. Pick one and climb aboard.` : "Nothing flying right now. Host a launch and be the first."}</p>
      </header>
      <main className={f.feed} aria-label="Rockets">
        {data.coins.length > 0 ? <RocketGrid initial={data.coins} /> : (
          <div className={st.empty}>
            <p>No rockets on the pad yet.</p>
            <Link href="/create" className="dsc3-btn dsc3-btn-primary">Host a launch</Link>
          </div>
        )}
      </main>
    </div>
  );
}
