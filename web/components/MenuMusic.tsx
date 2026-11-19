"use client";
/** Mounts the iPhone app's menu music (lib/game/menuMusic) once in the root layout and tells it which screen is open. */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { startMenuMusic } from "@/lib/game/menuMusic";

export default function MenuMusic() {
  const path = usePathname() || "/";
  const ctl = useRef<ReturnType<typeof startMenuMusic> | null>(null);
  useEffect(() => { const c = startMenuMusic(); ctl.current = c; return () => { c.stop(); ctl.current = null; }; }, []);
  useEffect(() => { ctl.current?.setPath(path); }, [path]);
  return null;
}
