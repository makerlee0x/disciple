/** Incognito mark (hat + glasses) for hidden launches: says "anon" without a sentence (maker 2026-11-19, show don't tell). */
export default function AnonGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 11.5h19" />
      <path d="M5 11.5 7 5h10l2 6.5" />
      <circle cx="7.5" cy="16.5" r="2.75" />
      <circle cx="16.5" cy="16.5" r="2.75" />
      <path d="M10.25 16.5c1.1-.8 2.4-.8 3.5 0" />
    </svg>
  );
}
