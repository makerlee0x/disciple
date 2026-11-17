/**
 * The three Privy sign-in methods (email, Google, X) as small monochrome marks. Replaces the "Sign in with email, Google,
 * X or wallet" helper lines (subcopy pass, maker 2026-11-17; sign-in is Privy-only, so no wallet mark).
 * currentColor, so it takes the muted text colour of wherever it sits.
 */
export default function SignInMarks({ size = 14, className }: { size?: number; className?: string }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true as const, style: { flex: "none" as const } };
  return (
    <span className={className} role="img" aria-label="Email, Google or X"
      style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.6), color: "var(--dsc-muted)" }}>
      <svg {...p} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7 7.5 6 7.5-6" /></svg>
      <svg {...p} fill="currentColor"><path d="M12 10.2v3.9h5.4c-.24 1.4-1.66 4.1-5.4 4.1a6.2 6.2 0 0 1 0-12.4c1.78 0 2.98.76 3.66 1.41l2.5-2.4C16.56 3.3 14.48 2.4 12 2.4a9.6 9.6 0 1 0 0 19.2c5.54 0 9.22-3.9 9.22-9.38 0-.63-.07-1.11-.15-1.6H12Z" /></svg>
      <svg {...p} fill="currentColor"><path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.17h1.7L7.4 4.73H5.58l11.09 14.44Z" /></svg>
    </span>
  );
}
