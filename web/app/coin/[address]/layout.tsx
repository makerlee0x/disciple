import { preload } from "react-dom";
import type { Metadata } from "next";
import { DEMO_POOL } from "@/lib/config";
import { cardMeta, titleCase } from "@/lib/ogMeta";

/** `output: 'export'` needs one pre-rendered path: the engine demo pool. Sample launchpad cards are gone. */
export function generateStaticParams() {
  return [{ address: DEMO_POOL.address }];
}

/** The rocket's link preview (step 7): title + line from live data, card from /api/og/rocket. */
export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  if (process.env.STATIC_PREVIEW === "1" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return {};
  const { rocketInfo } = await import("@/lib/server/og/data");
  const { tierName } = await import("@/lib/server/og/card");
  const r = await rocketInfo(address).catch(() => null);
  if (!r) return {};
  const title = `$${r.ticker} · ${r.name} · DISCIPLE`;
  const tier = r.mcapUsd != null ? titleCase(tierName(r.mcapUsd)) : null;
  const line = r.graduated
    ? "Reached orbit. Hop aboard and ride it higher."
    : tier && r.orbitPct != null ? `In ${tier}, ${Math.round(r.orbitPct)}% to orbit. Hop aboard and help boost it.` : "Hop aboard and help boost it to orbit.";
  return cardMeta(title, line, `/api/og/rocket?coin=${address.toLowerCase()}`, `$${r.ticker} on DISCIPLE`);
}

export default function CoinLayout({ children }: { children: React.ReactNode }) {
  // The page under it renders client-side only (useSearchParams), so the engine preload has to come from here to be in
  // the first HTML; the flight engine then downloads while the page JS does (it used to start after hydration).
  preload(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}${process.env.NEXT_PUBLIC_FLIGHT_ENGINE || "/flight/engine.js"}`, { as: "script" });
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PRICE_PREFETCH }} />
      {children}
    </>
  );
}

/** Inline, in the first HTML: fetch the coin's mcap while the page JS downloads, so the engine's first frame needs no
 *  chain read (engine.js DiscipleSource.start reads window.__discipleSsrState). The page is static-cached, so the price
 *  can't be baked into the HTML itself. Graduated coins are skipped (their pool fields come from the browser's read). */
const PRICE_PREFETCH = `(function(){try{var tq=new URLSearchParams(location.search).get("timing");if(tq==="1")localStorage.setItem("disciple.tradeTiming","1");else if(tq==="0")localStorage.removeItem("disciple.tradeTiming");}catch(e){}try{var m=location.pathname.match(/\\/coin\\/(0x[0-9a-fA-F]{40})/);if(!m)return;var c=m[1].toLowerCase();
fetch(${JSON.stringify(process.env.NEXT_PUBLIC_BASE_PATH || "")}+"/api/coin/mcap?coin="+c).then(function(r){return r.ok?r.json():null}).then(function(j){
if(!j||j.graduated||!(j.mcapUsd>0))return;var s={type:"State",mcapUsd:j.mcapUsd,graduated:false,poolId:null,graduatedAt:null,coin:c};window.__discipleSsrState=s;
if(window.__flight&&!window.__discipleLastState)dispatchEvent(new CustomEvent("disciple:event",{detail:s}));}).catch(function(){});}catch(e){}})();`;
