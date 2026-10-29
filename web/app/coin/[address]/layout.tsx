import { DEMO_POOL } from "@/lib/config";

/** `output: 'export'` needs one pre-rendered path: the engine demo pool. Sample launchpad cards are gone. */
export function generateStaticParams() {
  return [{ address: DEMO_POOL.address }];
}

export default function CoinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
