"use client";

import Sidebar from "./Sidebar";
import { usePathname } from "next/navigation";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isGame = pathname.startsWith("/coin/");
  return (
    <>
      <Sidebar forceCollapsed={isGame ? undefined : undefined} />
      {isGame ? children : <div className="main-offset min-h-screen">{children}</div>}
      {IS_STATIC_PREVIEW && (
        <div
          aria-label="Static preview"
          style={{
            position: "fixed",
            right: 10,
            bottom: 10,
            zIndex: 9999,
            padding: "4px 8px",
            borderRadius: 8,
            fontSize: 10,
            letterSpacing: ".08em",
            color: "#0a0c1a",
            background: "rgba(255,231,163,.92)",
            border: "1px solid rgba(255,220,150,.8)",
            boxShadow: "0 2px 12px rgba(0,0,0,.35)",
            pointerEvents: "none",
          }}
        >
          Static preview
        </div>
      )}
    </>
  );
}
