"use client";
/** /duel: Trading Duel on its own, as a guest (no sign-in): play a bot, or send a friend a duel link. Play fuel only. */
import dynamic from "next/dynamic";

const DuelScreen = dynamic(() => import("@/components/turbo/duel/DuelScreen"), { ssr: false });

export default function DuelOnlyPage() {
  return <DuelScreen guest />;
}
