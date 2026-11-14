import { notFound } from "next/navigation";
import { LOGBOOK_ENABLED } from "@/lib/features";
import StreaksView from "@/components/streaks/StreaksView";

export const metadata = { title: "Streaks · DISCIPLE" };

export default function Page() {
  if (!LOGBOOK_ENABLED) notFound();
  return <StreaksView />;
}
