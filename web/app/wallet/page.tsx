"use client";
import { useRouter } from "next/navigation";
import CashBody from "@/components/cash/CashBody";

/** /wallet (old links): the Cash popup's body on its own page (round 2 "Cash" board). Close goes back to the lobby. */
export default function WalletPage() {
  const router = useRouter();
  return (
    <div className="page-shell cx-page" data-testid="wallet-page">
      <section className="ds-modal r2-modal cx-sheet cx-static" aria-label="Cash">
        <CashBody onClose={() => router.push("/")} />
      </section>
    </div>
  );
}
