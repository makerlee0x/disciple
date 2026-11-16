"use client";
/**
 * The iPhone app gets its own home (components/app/AppHome, concept C), the website keeps its lobby. A tiny script in the
 * root layout (APP_JS) adds html.app from the app's user agent before the first paint, so CSS shows the right one at once;
 * after mount the other is unmounted. The home is ISR, so the server can't read the user agent here.
 */
import { useEffect, useState, type ReactNode } from "react";
import { isNativeApp } from "@/lib/native";

export default function AppSwitch({ web, app }: { web: ReactNode; app: ReactNode }) {
  const [which, setWhich] = useState<"both" | "web" | "app">("both");
  useEffect(() => { setWhich(isNativeApp() ? "app" : "web"); }, []);
  return (<>
    {which !== "app" && <div className="app-web">{web}</div>}
    {which !== "web" && <div className="app-only">{app}</div>}
  </>);
}
