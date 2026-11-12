/**
 * X (Twitter) account linking: shared types and the signed messages (client + server).
 * Flow (OAuth 2.0 authorization code + PKCE, confidential client):
 *   1. client: GET /api/x?nonce=1&address → nonce; the wallet signs xConnectMessage; POST /api/x/connect → { url }
 *   2. browser goes to X, the player approves, X redirects to /api/x/callback?code&state
 *   3. server swaps the code for a token, reads /2/users/me, stores the link, redirects to /profile?x=linked
 * The link is verified by X itself, so a linked handle is never self-reported. One X account links to one wallet.
 */

export interface XLink {
  /** X's numeric user id (stable across handle changes). */
  id: string;
  /** Handle without "@", as X returned it at link time. */
  username: string;
  /** ms epoch */
  linkedAt: number;
}

export interface XLinkStatus {
  /** false when the server has no X app configured (X_CLIENT_ID / X_CLIENT_SECRET): the UI hides Connect X. */
  enabled: boolean;
  link: XLink | null;
}

/** Query param the callback adds on its redirect back to the profile. */
export const X_RESULT_PARAM = "x";
export type XResult = "linked" | "taken" | "denied" | "expired" | "error";

export const X_RESULT_COPY: Record<XResult, string> = {
  linked: "X account linked.",
  taken: "That X account is already linked to another pilot.",
  denied: "X linking was cancelled.",
  expired: "That link request expired. Try again.",
  error: "Couldn't link your X account. Try again.",
};

export const isXResult = (v: unknown): v is XResult => typeof v === "string" && v in X_RESULT_COPY;

export const xConnectMessage = (address: string, nonce: string) =>
  `DISCIPLE: link an X account\n\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;

export const xDisconnectMessage = (address: string, nonce: string) =>
  `DISCIPLE: unlink X account\n\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;

/** X handles: 1–15 of A–Z, a–z, 0–9, _ */
export const isXUsername = (u: unknown): u is string => typeof u === "string" && /^[A-Za-z0-9_]{1,15}$/.test(u);
