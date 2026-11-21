"use client";
/**
 * The Cash popup (round 2 "Cash" board): opens on OPEN_CASH_EVENT (lib/cashLink), from the top-bar cash chip, Add cash
 * in the Hangar and any other cash link. Desktop: a centred popup like the Hangar popups. Phone: full screen with a back
 * arrow. On /wallet the page shows the same body itself, so the popup stays shut there.
 */
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Sheet from "@/components/profile/Sheet";
import { OPEN_CASH_EVENT, takePendingCash, type CashTab } from "@/lib/cashLink";

const CashBody = dynamic(() => import("./CashBody"), { ssr: false });

export default function CashHost() {
  const [tab, setTab] = useState<CashTab | null>(null);
  const path = usePathname();
  useEffect(() => {
    const f = (e: Event) => {
      takePendingCash();
      if (window.location.pathname === "/wallet") return;
      setTab((e as CustomEvent<{ tab?: CashTab } | null>).detail?.tab ?? "add");
    };
    window.addEventListener(OPEN_CASH_EVENT, f);
    // a cash tap that came before this lazy host was listening (fresh page load) still opens it
    const early = takePendingCash();
    if (early && window.location.pathname !== "/wallet") setTab(early);
    return () => window.removeEventListener(OPEN_CASH_EVENT, f);
  }, []);
  // a route change closes it (not the first mount, which may be opening an early tap)
  const lastPath = useRef(path);
  useEffect(() => { if (lastPath.current !== path) { lastPath.current = path; setTab(null); } }, [path]);
  return (
    <Sheet open={tab != null} onClose={() => setTab(null)} label="Cash" className="r2-modal cx-sheet" testId="cash-popup">
      {tab && <CashBody key={tab} initialTab={tab} onClose={() => setTab(null)} />}
    </Sheet>
  );
}
