export default function Page() {
  return (
    <div className="page-shell">
      <h1>Achievements</h1>
      <div className="sub">CHOIR OF DEEDS</div>
      <span className="tag mock">MOCK DATA · PLACEHOLDER</span>
      <div className="card">

        <div className="row"><span>FIRST FLAME</span><span>first confirmed thrust</span></div>
        <div className="row"><span>TIER WITNESS</span><span>cross a tier</span></div>
        <div className="row"><span>WALL BREAKER</span><span>lined up when a wall breaks</span></div>
        <div className="row"><span>PERFECT LANE ×10</span><span>10 reward orbs in a row</span></div>
        <div className="row"><span>KING OF THE HILL</span><span>top fueler</span></div>
        <p className="note">Achievement unlocks are local in the flight prototype; persistence TBD.</p>

      </div>
    </div>
  );
}
