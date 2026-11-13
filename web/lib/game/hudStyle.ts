/**
 * Flight HUD look (brand v3, web/app/brand-tokens-v3.css): one place for the DOM cards on the flight screen
 * (trade bar, Your bag, crew feed, mode switch) so they match the canvas cards drawn by public/flight/engine.js.
 */
export const HUD = {
  game: "var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif)",
  ui: "var(--dsc-font-ui, var(--font-geist-sans), system-ui, sans-serif)",
  ink: "#121327",
  glass: "rgba(18,19,39,0.78)",
  border: "#2E323A",
  borderGold: "rgba(243,223,168,0.3)",
  text: "#F2F3F7",
  dim: "rgba(215,217,228,0.78)",
  gold: "#F2C14E",
  champagne: "#F3DFA8",
  up: "#5FF0A0",
  down: "#F0307F",
  downSoft: "#FF9CC4",
  hard: "#FF7A3D",
  radius: 16,
  control: 12,
} as const;

/** small tracked label above a value (ALTITUDE, YOUR BAG, BOOST AMOUNT) */
export const hudLabel = { font: `600 13px/1.1 ${HUD.game}`, letterSpacing: "0.12em", color: HUD.dim, textTransform: "uppercase" } as const;
/** a HUD card: glass panel, hairline border, tile radius */
export const hudCard = { background: HUD.glass, border: `1px solid ${HUD.border}`, borderRadius: HUD.radius, color: HUD.text, fontFamily: HUD.ui, boxSizing: "border-box" } as const;
