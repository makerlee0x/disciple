"use client";
/**
 * The Turbo popup's host (maker 2026-11-20): opens on OPEN_TURBO_EVENT from the Turbo pill (lib/turbo/turboPill).
 * Same shell as the Cash popup: centred on desktop, full screen with a back arrow on phones. Closes on navigation.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sheet from "@/components/profile/Sheet";
import { OPEN_TURBO_EVENT, type TurboTab } from "@/lib/turbo/turboPill";

const TurboCashBody = dynamic(() => import("./TurboCashBody"), { ssr: false });

export default function TurboCashHost() {
  const [tab, setTab] = useState<TurboTab | null>(null);
  const path = usePathname();
  useEffect(() => {
    const f = (e: Event) => setTab((e as CustomEvent<{ tab?: TurboTab } | null>).detail?.tab ?? "add");
    window.addEventListener(OPEN_TURBO_EVENT, f);
    return () => window.removeEventListener(OPEN_TURBO_EVENT, f);
  }, []);
  useEffect(() => { setTab(null); }, [path]);
  return (
    <Sheet open={tab != null} onClose={() => setTab(null)} label="Turbo" className="r2-modal cx-sheet tc-sheet" testId="turbo-popup">
      {tab && <TurboCashBody key={tab} initialTab={tab} onClose={() => setTab(null)} />}
    </Sheet>
  );
}
