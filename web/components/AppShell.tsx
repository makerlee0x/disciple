"use client";

import Sidebar from "./Sidebar";
import { usePathname } from "next/navigation";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isGame = pathname.startsWith("/coin/");
  return (
    <>
      <Sidebar forceCollapsed={isGame ? undefined : undefined} />
      {isGame ? children : <div className="main-offset min-h-screen">{children}</div>}
    </>
  );
}
