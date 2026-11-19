/**
 * Coin flight route loading (maker 2026-11-18: "way too many screens that go from press launch to flying"). No clip and
 * no logo screen here: the flight's own night sky, so the launch → flight hand-off reads as one cut, not a third screen.
 */
export default function Loading() {
  return <div role="status" aria-label="Loading" data-testid="flight-loading" style={{ position: "fixed", inset: 0, zIndex: 80, background: "#05060c" }} />;
}
