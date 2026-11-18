"use client";
/**
 * iOS (the iPhone app and Safari) zooms the page in when a field under 16px gets focus, and stays zoomed after, so every
 * screen after it pans sideways (Settings, Nov 17). maximum-scale=1 stops that zoom. Safari still lets people pinch-zoom;
 * the app (WKWebView) doesn't, which suits a game. Android and desktop are left alone.
 * Set after hydration (changing the tag before it made React add a second one), and again whenever Next rewrites it.
 */
import { useEffect } from "react";

export const isIos = (ua: string, touchPoints = 0) => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);

export default function IosZoomLock() {
  useEffect(() => {
    if (!isIos(navigator.userAgent, navigator.maxTouchPoints)) return;
    const lock = () => {
      const m = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
      if (m && !m.content.includes("maximum-scale")) m.setAttribute("content", `${m.content}, maximum-scale=1`);
    };
    lock();
    // Next writes the viewport tag again on client navigation
    const mo = new MutationObserver(lock);
    mo.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["content"] });
    return () => mo.disconnect();
  }, []);
  return null;
}
