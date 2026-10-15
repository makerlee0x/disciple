import { DEMO_POOL } from "@/lib/config";

/** Pre-render demo + sample launchpad cards for `output: 'export'`. */
export function generateStaticParams() {
  return [
    { address: DEMO_POOL.address },
    { address: "sample-halo" },
    { address: "sample-limbo" },
    { address: "sample-choir" },
    { address: "sample-seraph" },
    { address: "sample-pearly" },
  ];
}

export default function CoinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
