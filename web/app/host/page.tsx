import HostView from "@/components/host/HostView";

export const metadata = { title: "Mission control · DISCIPLE" };

/** /host?coin=0x…: one rocket's mission control. Read client side (static preview has no server query). */
export default function Page() {
  return <HostView />;
}
