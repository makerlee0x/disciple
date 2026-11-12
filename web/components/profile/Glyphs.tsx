/**
 * Profile r3 line icons that are not in the icons v1 / v1.1 sprite (BRAND drew them for the r3 boards, same style:
 * 24px, 1.5px stroke, round caps): chest (Rewards), pencil (edit picture / banner), trash (remove banner),
 * plus the X mark (same glyph as quick-launch r4).
 */
type P = { size?: number; className?: string };
const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function ChestGlyph({ size = 20, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden {...line}>
      <path d="M3.75 10.5V9.25A5.25 5.25 0 0 1 9 4h6a5.25 5.25 0 0 1 5.25 5.25v1.25" />
      <path d="M3.75 10.5h16.5v8a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M8 4.4v6.1M16 4.4v6.1" />
      <rect x="10.25" y="9" width="3.5" height="4.25" rx="1" />
    </svg>
  );
}
export function PencilGlyph({ size = 18, className }: P) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden {...line}><path d="M15.25 5.25l3.5 3.5M4.5 19.5l1-4.25L16 4.75a1.77 1.77 0 0 1 2.5 0l.75.75a1.77 1.77 0 0 1 0 2.5L8.75 18.5z" /></svg>;
}
export function TrashGlyph({ size = 18, className }: P) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden {...line}><path d="M4.5 6.75h15M9.75 6.75V5.25a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v1.5M6.5 6.75l.85 11.6a1.5 1.5 0 0 0 1.5 1.4h6.3a1.5 1.5 0 0 0 1.5-1.4l.85-11.6M10.25 10.5v5.5M13.75 10.5v5.5" /></svg>;
}
export function XGlyph({ size = 18, className }: P) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden fill="currentColor"><path d="M13.8 11.2L21 3h-2.4l-5.5 6.3L8.4 3H3l7.5 10.1L3 21h2.4l6-6.8L15.6 21H21L13.8 11.2zM6 4.5h1.7L18 19.5h-1.7L6 4.5z" /></svg>;
}
