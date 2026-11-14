"use client";
/**
 * Add to Home Screen (maker, 2026-11-14 mobile first run). After a player's first real boost, back in the lobby, a bottom
 * sheet offers to put DISCIPLE on the home screen: full screen, one tap to open, and on iPhones the only way web push
 * alerts (crew, streaks) can reach them. Android/Chrome: the browser's own install prompt. iPhone: Safari has no prompt,
 * so the sheet shows the two taps (Share, then Add to Home Screen). "Not now" backs off (lib/firstRun).
 */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { loadRun, saveRun, shouldOfferInstall } from "@/lib/firstRun";
import { currentInApp, isIOS } from "@/lib/inAppBrowser";
import { isCollapsibleRoute } from "@/components/Sidebar";

type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const isPhone = () => typeof window !== "undefined" && (document.documentElement.classList.contains("ap-phone") || matchMedia("(max-width: 760px) and (pointer: coarse)").matches);
const isStandalone = () => typeof window !== "undefined" && (matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true);

export default function InstallPrompt() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const bip = useRef<BIP | null>(null);
  useEffect(() => {
    const f = (e: Event) => { e.preventDefault(); bip.current = e as BIP; };
    addEventListener("beforeinstallprompt", f);
    return () => removeEventListener("beforeinstallprompt", f);
  }, []);
  useEffect(() => {
    if (isCollapsibleRoute(path)) { setOpen(false); return; }   // never over a flight
    const t = setTimeout(() => {
      if (shouldOfferInstall(loadRun(), { phone: isPhone(), standalone: isStandalone(), inApp: !!currentInApp(), now: Date.now() })) {
        setOpen(true); saveRun({ installAt: Date.now() });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [path]);
  if (!open) return null;
  const ios = isIOS(navigator.userAgent);
  const no = () => { const r = loadRun(); saveRun({ installAt: Date.now(), installNo: r.installNo + 1 }); setOpen(false); };
  const install = async () => {
    const e = bip.current;
    if (!e) return;
    await e.prompt().catch(() => undefined);
    const c = await e.userChoice.catch(() => null);
    bip.current = null;
    if (c?.outcome === "accepted") { saveRun({ installNo: 9 }); setOpen(false); } else no();
  };
  return (
    <div className="a2hs-wrap" role="dialog" aria-modal="true" aria-labelledby="a2hs-t" data-testid="install-prompt" onPointerDown={(e) => { if (e.target === e.currentTarget) no(); }}>
      <div className="a2hs">
        <img src="/icon-192.png" alt="" width={56} height={56} className="a2hs-ic" />
        <b id="a2hs-t">Put DISCIPLE on your home screen</b>
        <span>Opens full screen in one tap, and you get alerts when your crew needs you.</span>
        {ios || !bip.current ? (
          <ol className="a2hs-steps">
            <li><i aria-hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg></i>Tap <b>Share</b> in the browser bar</li>
            <li><i aria-hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8v8M8 12h8" /></svg></i>Then <b>Add to Home Screen</b></li>
          </ol>
        ) : (
          <button type="button" className="r2-gold" onClick={install}>Add to home screen</button>
        )}
        <button type="button" className="a2hs-no" onClick={no}>{ios || !bip.current ? "Got it" : "Not now"}</button>
      </div>
    </div>
  );
}
