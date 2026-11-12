/* Brand v3 reference page (next dev only, via app/dev/layout.tsx). Shows every v3 token and .dsc3-* class in use,
   so new screens can copy from here. Guide: docs/brand-v3.md */

const swatches: { group: string; items: { name: string; token: string; note: string }[] }[] = [
  {
    group: "Sky",
    items: [
      { name: "Night", token: "--dsc3-sky-night", note: "Page base" },
      { name: "Ink", token: "--dsc3-sky-ink", note: "Deep panels, text on gold" },
      { name: "Indigo", token: "--dsc3-sky-indigo", note: "Hero lower sky" },
      { name: "Dusk", token: "--dsc3-sky-dusk", note: "Page glow" },
      { name: "Periwinkle", token: "--dsc3-sky-periwinkle", note: "Hero upper sky" },
    ],
  },
  {
    group: "Light",
    items: [
      { name: "Gold", token: "--dsc3-light-gold", note: "Primary action, rewards" },
      { name: "Champagne", token: "--dsc3-light-champagne", note: "Links, rim light" },
      { name: "Pearl", token: "--dsc3-light-pearl", note: "Beams, bloom cores" },
    ],
  },
  {
    group: "Signal",
    items: [
      { name: "Up", token: "--dsc3-signal-up", note: "Climbing, gains, live" },
      { name: "Down", token: "--dsc3-signal-down", note: "Dumps, losses, danger" },
      { name: "Info", token: "--dsc3-signal-info", note: "Neutral live info" },
    ],
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 56 }}>
      <h2 className="dsc3-h2">{title}</h2>
      {children}
    </section>
  );
}

export default function BrandV3Page() {
  return (
    <main className="dsc3-grain" style={{ minHeight: "100vh", background: "var(--dsc3-page-bg)", color: "var(--dsc-text)" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px 96px" }}>
        <span className="dsc3-label">Brand v3 · light on film</span>
        <h1 className="dsc3-hero" style={{ marginTop: 12 }}>Disciple brand</h1>
        <p style={{ font: "var(--dsc3-type-body)", color: "var(--dsc3-text-on-sky)", maxWidth: 560, marginTop: 16 }}>
          The moodboard sets the atmosphere: film grain, soft bloom, deep night sky, chrome under hard light. Game menus set the
          structure: a lobby tab bar, shop shelves, a garage turntable, mission bars.
        </p>

        <Section title="Colour">
          {swatches.map((g) => (
            <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <h3 className="dsc3-h3">{g.group}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
                {g.items.map((s) => (
                  <div key={s.token} className="dsc3-panel" style={{ overflow: "hidden" }}>
                    <div style={{ height: 72, background: `var(${s.token})` }} />
                    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      <span className="dsc3-label">{s.token}</span>
                      <span style={{ font: "var(--dsc3-type-small)", color: "var(--dsc-muted)" }}>{s.note}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section title="Type">
          <div className="dsc3-panel" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <p className="dsc3-hero">Launch a rocket</p>
            <p className="dsc3-h1">Join a flight</p>
            <p className="dsc3-h2">Climbing now</p>
            <p className="dsc3-h3">Halo Runner</p>
            <p className="dsc3-stat">$214K</p>
            <p style={{ font: "var(--dsc3-type-body)", margin: 0 }}>Body copy is Geist. One line where possible, two at most.</p>
            <p className="dsc3-label" style={{ margin: 0 }}>HALO · Tier 9 · Stratosphere</p>
          </div>
        </Section>

        <Section title="Buttons">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <button className="dsc3-btn dsc3-btn-primary dsc3-btn-lg">Start a launch</button>
            <button className="dsc3-btn dsc3-btn-white">Drop in</button>
            <button className="dsc3-btn dsc3-btn-ghost">How to play</button>
            <button className="dsc3-chip" aria-pressed="true">All</button>
            <button className="dsc3-chip" aria-pressed="false">Verified</button>
          </div>
          <p style={{ font: "var(--dsc3-type-small)", color: "var(--dsc-muted)", margin: 0 }}>
            Gold is the one main action on a screen. Every control is at least 44px tall.
          </p>
        </Section>

        <Section title="Difficulty badges">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <span className="dsc3-badge dsc3-badge-easy"><span>Easy</span></span>
            <span className="dsc3-badge dsc3-badge-hard"><span>Hard</span></span>
            <span className="dsc3-badge dsc3-badge-expert" title="Trench"><span>Expert</span></span>
            <span className="dsc3-badge dsc3-badge-orbit"><span>In orbit</span></span>
          </div>
          <p style={{ font: "var(--dsc3-type-small)", color: "var(--dsc-muted)", margin: 0 }}>
            Easy = PVE, Hard = PVP, Expert = TRENCH (nickname &ldquo;Trench&rdquo;). Limits apply only before orbit, so a graduated
            rocket shows In orbit.
          </p>
        </Section>

        <Section title="Progress">
          <div className="dsc3-panel" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 }}>
            <div className="dsc3-bar dsc3-bar-climb" role="img" aria-label="61 percent to orbit"><i style={{ width: "61%" }} /></div>
            <div className="dsc3-bar dsc3-bar-orbit" role="img" aria-label="94 percent to orbit"><i style={{ width: "94%" }} /></div>
            <div className="dsc3-bar dsc3-bar-thin" role="img" aria-label="Mission two of three"><i style={{ width: "66%" }} /></div>
          </div>
        </Section>

        <Section title="Hero recipe">
          <div className="dsc3-panel-hero dsc3-grain" style={{ position: "relative", minHeight: 480 }}>
            <div className="dsc3-beam" style={{ right: "12%" }} aria-hidden="true" />
            <div className="dsc3-stand" style={{ right: "9%", bottom: 36 }} aria-hidden="true"><i /><i /><i /><i /><i /></div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/rocket-hi.webp"
              alt="A chrome Disciple rocket on its launch stand"
              style={{ position: "absolute", right: "calc(9% + 72px)", bottom: 92, height: 360 }}
            />
            <div style={{ padding: 48, maxWidth: 420, display: "flex", flexDirection: "column", gap: 20 }}>
              <h3 className="dsc3-hero">Launch a rocket</h3>
              <p style={{ font: "var(--dsc3-type-body)", color: "var(--dsc3-text-on-sky)", margin: 0 }}>
                Make it yours, then send it to orbit.
              </p>
              <div><button className="dsc3-btn dsc3-btn-primary dsc3-btn-lg">Start a launch</button></div>
            </div>
          </div>
          <p style={{ font: "var(--dsc3-type-small)", color: "var(--dsc-muted)", margin: 0 }}>
            Sky gradient + one bloom + one beam + the stand + grain. The hero object always stands on something.
          </p>
        </Section>

        <Section title="Tile">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
            <a href="#" className="dsc3-tile">
              <div style={{ position: "relative", height: 200, background: "linear-gradient(180deg, #241631, #121327)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                <div className="dsc3-bloom" style={{ width: 160, height: 160, top: 18, left: "50%", marginLeft: -80 }} aria-hidden="true" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/assets/rocket-hi.webp" alt="" style={{ position: "relative", height: 172, marginBottom: 8 }} />
                <span className="dsc3-badge dsc3-badge-easy" style={{ position: "absolute", left: 12, bottom: 12 }}><span>Easy</span></span>
              </div>
              <div style={{ padding: "14px 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="dsc3-h3">Halo Runner</span>
                <div style={{ display: "flex", justifyContent: "space-between", font: "var(--dsc3-type-small)" }}>
                  <span>$214K altitude</span>
                  <span style={{ color: "var(--dsc3-signal-up)", fontWeight: 600 }}>+38%</span>
                </div>
              </div>
            </a>
          </div>
        </Section>
      </div>
    </main>
  );
}
