/**
 * The iPhone app's home, on its own (perf pass 2026-11-21). middleware.ts sends "/" here when the user agent carries the
 * app's tag (lib/native NATIVE_UA_TAG), so the app no longer downloads, renders and then throws away the website lobby
 * (its HTML, its JS and five eager mode plates) on every launch. The address bar still says "/". The website's "/"
 * (app/page.tsx, with AppSwitch as the fallback for an app build without the tag) is unchanged.
 */
import type { Metadata } from "next";
import AppHome from "@/components/app/AppHome";
import { getHomeData } from "@/lib/server/home";

export const revalidate = 30;
export const metadata: Metadata = { robots: { index: false } };

export default async function AppHomePage() {
  const data = await getHomeData();
  return <div className="app-only" style={{ display: "block" }}><AppHome initial={data} /></div>;
}
