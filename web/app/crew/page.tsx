import { notFound } from "next/navigation";
import { CREW_ENABLED } from "@/lib/features";
import CrewView from "@/components/crew/CrewView";

export const metadata = { title: "Crew · DISCIPLE" };

export default function Page() {
  if (!CREW_ENABLED) notFound();
  return <CrewView />;
}
