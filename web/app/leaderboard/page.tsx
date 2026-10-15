export default function Page() {
  return (
    <div className="page-shell">
      <h1>Leaderboard</h1>
      <div className="sub">TOP PILOTS · SAMPLE DATA</div>
      <span className="tag mock">MOCK DATA · PLACEHOLDER</span>
      <div className="card">

        <div className="row"><span>👑 0xA11…ce</span><span>12,480 pts</span></div>
        <div className="row"><span>2 0xB0b…42</span><span>9,115 pts</span></div>
        <div className="row"><span>3 0xC4t…77</span><span>6,020 pts</span></div>
        <div className="row"><span>… you</span><span>0 pts</span></div>
        <p className="note">Scores are mock. Real KOTH / % moved scoring TBD with indexer.</p>

      </div>
    </div>
  );
}
