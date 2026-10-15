export default function Page() {
  return (
    <div className="page-shell">
      <h1>Wallet / Deposit</h1>
      <div className="sub">ONE APPROVAL · NO PER-TRADE SIGNING</div>
      <span className="tag mock">MOCK DATA · PLACEHOLDER</span>
      <div className="card">
        <div className="row">
          <span>Paper balance</span>
          <span>$250.00</span>
        </div>
        <div className="row">
          <span>Chain</span>
          <span>Robinhood Chain (4663)</span>
        </div>
        <div className="row">
          <span>Deposit asset</span>
          <span>USDG only (v0)</span>
        </div>
        <div className="row">
          <span>Gas / trade</span>
          <span>≈ $0.0098 (not sponsored)</span>
        </div>
        <p className="note">
          Production: one USDG approval at deposit; platform executes shots.
          Withdraw USDG on Robinhood Chain only. Privy + vault TBD (DISCIPLE
          FLOW).
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className="rounded-xl border border-[rgba(255,231,163,.45)] px-4 py-2 text-[#ffe7a3]"
            disabled
          >
            Deposit (TBD)
          </button>
          <button
            type="button"
            className="rounded-xl border border-[rgba(255,231,163,.45)] px-4 py-2 text-[#ffe7a3]"
            disabled
          >
            Withdraw (TBD)
          </button>
        </div>
      </div>
    </div>
  );
}
