import CashPanel from "@/components/profile/CashPanel";

/** Cash: dollar balance, Deposit and Withdraw (lee, Oct 30: moved here from the profile's Settings popup). */
export default function WalletPage() {
  return (
    <div className="page-shell" data-testid="wallet-page">
      <CashPanel />
    </div>
  );
}
