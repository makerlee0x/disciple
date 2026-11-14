import { notFound } from "next/navigation";
import { LOGBOOK_ENABLED } from "@/lib/features";
import LogbookView from "@/components/logbook/LogbookView";

export const metadata = { title: "Logbook · DISCIPLE" };

/** /logbook = yours; /logbook?wallet=0x… = another pilot's closed flights (Top pilots links here). Read client side. */
export default function Page() {
  if (!LOGBOOK_ENABLED) notFound();
  return <LogbookView />;
}
