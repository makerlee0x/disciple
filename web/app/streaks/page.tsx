import StreaksView from "@/components/streaks/StreaksView";

export const metadata = { title: "Streaks · DISCIPLE" };

/** Open to everyone since the retention loop (2026-11-21): the flight streak, daily drop and season track don't need the logbook. */
export default function Page() {
  return <StreaksView />;
}
