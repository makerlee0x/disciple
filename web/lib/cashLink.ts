/**
 * The Deposit link (SITE new-player cash). CashPanel lives in the private profile's Settings modal, so "/profile#cash"
 * must OPEN that modal (ProfileDashboard opens it on #cash / #settings, on load and on hashchange) and scroll to the
 * panel. Already on /profile with #cash in the URL, a click doesn't fire hashchange ⇒ the link also fires OPEN_CASH_EVENT.
 */
export const DEPOSIT_HREF = "/profile#cash";
export const OPEN_CASH_EVENT = "disciple:opencash";
/** Hashes that open Settings on the private profile; "#cash" also scrolls to the Cash panel. */
export const SETTINGS_HASHES = ["#settings", "#cash"] as const;

/** onClick for any Deposit link: on /profile, open the panel in place (no reload); elsewhere, navigate normally. */
export function onDepositClick(e: { preventDefault(): void }) {
  if (typeof window === "undefined" || window.location.pathname !== "/profile") return;
  e.preventDefault();
  if (window.location.hash !== "#cash") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#cash`);
  window.dispatchEvent(new Event(OPEN_CASH_EVENT));
}
