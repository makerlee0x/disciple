/**
 * Bridge between the wallet pill (components/WalletButton.tsx, lazy chunk) and the Sidebar menu.
 * On phones (< 740px) the signed-out pill ("Play") is hidden from the top bar so GAME's ✕ owns the corner;
 * the Sidebar shows the same action instead. Plain window events keep the wallet chunk out of the Sidebar's bundle.
 */
/** CustomEvent<{ label: string | null }>: the pill's current signed-out label, or null when signed in / not shown. */
export const WALLET_CTA_EVENT = "disciple:wallet-cta";
/** Event: the Sidebar item was tapped; the wallet pill runs its own action. */
export const WALLET_CTA_CLICK_EVENT = "disciple:wallet-cta-click";
/** Last published label (for a Sidebar that mounts after the pill). */
export const walletCtaLabel = (): string | null =>
  typeof window === "undefined" ? null : ((window as unknown as { __walletCta?: string | null }).__walletCta ?? null);
/** Sidebar "Settings" item → GAME's settings menu (components/flight/SettingsMenu.tsx listens on window). */
export const SETTINGS_OPEN_EVENT = "disciple:settings-open";

/** The signed-in wallet's identity for the Sidebar's account card (premium-ui-r1): display only, published by the wallet
 *  pill (it already resolves the address + claimed name). CustomEvent<WalletId | null>; null when signed out. */
export type WalletId = { address: string; name: string | null };
export const WALLET_ID_EVENT = "disciple:wallet-id";
/** Last published identity (for a Sidebar that mounts after the pill). */
export const walletId = (): WalletId | null =>
  typeof window === "undefined" ? null : ((window as unknown as { __walletId?: WalletId | null }).__walletId ?? null);
