"use client";
/**
 * The Cash popup (round 2 "Cash" board): opens on OPEN_CASH_EVENT (lib/cashLink), from the top-bar cash chip, Add cash
 * in the Hangar and any other cash link. Desktop: a centred popup like the Hangar popups. Phone: full screen with a back
 * arrow. On /wallet the page shows the same body itself, so the popup stays shut there.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sheet from "@/components/profile/Sheet";
import { OPEN_CASH_EVENT, type CashTab } from "@/lib/cashLink";

const CashBody = dynamic(() => import("./CashBody"), { ssr: false });

export default function CashHost() {
  const [tab, setTab] = useState<CashTab | null>(null);
  const path = usePathname();
  useEffect(() => {
    const f = (e: Event) => {
      if (window.location.pathname === "/wallet") return;
      setTab((e as CustomEvent<{ tab?: CashTab } | null>).detail?.tab ?? "add");
    };
    window.addEventListener(OPEN_CASH_EVENT, f);
    return () => window.removeEventListener(OPEN_CASH_EVENT, f);
  }, []);
  useEffect(() => { setTab(null); }, [path]);
  return (
    <Sheet open={tab != null} onClose={() => setTab(null)} label="Cash" className="r2-modal cx-sheet" testId="cash-popup">
      {tab && <CashBody key={tab} initialTab={tab} onClose={() => setTab(null)} />}
    </Sheet>
  );
}
