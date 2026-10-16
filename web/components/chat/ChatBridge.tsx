"use client";
/** Installs window.DiscipleChat (real client, or the local mock with ?chatmock=1) for plain-JS engine code. Renders nothing. */
import { useEffect } from "react";
import { installGlobal } from "@/lib/chat/client";
import { installMock } from "@/lib/chat/mock";
export default function ChatBridge() {
  useEffect(() => {
    if (new URLSearchParams(location.search).get("chatmock") === "1") installMock(); else installGlobal();
  }, []);
  return null;
}
