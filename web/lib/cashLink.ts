/**
 * The Deposit link (SITE new-player cash). Cash (balance, Deposit, Withdraw) lives on /wallet (lee, Oct 30: it moved out
 * of the profile's Settings popup). Old "/profile#cash" links still land there: ProfileDashboard sends #cash to /wallet.
 * Already on /wallet, a click opens the Deposit tab in place (OPEN_CASH_EVENT, no reload).
 */
export const DEPOSIT_HREF = "/wallet";
export const OPEN_CASH_EVENT = "disciple:opencash";
/** Hash that opens Settings on the private profile. */
export const SETTINGS_HASHES = ["#settings"] as const;
/** Legacy hash (old Deposit links): /profile#cash forwards to DEPOSIT_HREF. */
export const LEGACY_CASH_HASH = "#cash";

/** onClick for any Deposit link: on /wallet, show the Deposit tab in place (no reload); elsewhere, navigate normally. */
export function onDepositClick(e: { preventDefault(): void }) {
  if (typeof window === "undefined" || window.location.pathname !== "/wallet") return;
  e.preventDefault();
  window.dispatchEvent(new Event(OPEN_CASH_EVENT));
}

/** The account menu's "Settings" link (SITE, Oct 30): opens the Settings popup; on /profile, in place (no reload). */
export const SETTINGS_HREF = "/profile#settings";
export const OPEN_SETTINGS_EVENT = "disciple:opensettings";
export function onSettingsClick(e: { preventDefault(): void }) {
  if (typeof window === "undefined" || window.location.pathname !== "/profile") return;
  e.preventDefault();
  if (window.location.hash !== "#settings") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#settings`);
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}
