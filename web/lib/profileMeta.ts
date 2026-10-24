/**
 * Profile basics beyond the username: profile picture, bio, country flag. Pure, shared client + server
 * (validation runs on both sides; the server is authoritative, see /api/profile/meta).
 *  - pfp: id (sha256) of an image that passed /api/moderate-image and sits in the moderated image store
 *    (served as /api/image/<id>). Never a raw URL from the client.
 *  - bio: plain text, control / zero-width / bidi-override chars stripped, whitespace collapsed, ≤ BIO_MAX code points.
 *  - flag: ISO 3166-1 alpha-2 country code (rendered as a flag emoji, same as the leaderboard `country` column).
 */
export const BIO_MAX = 160;
export const PFP_ID_RE = /^[0-9a-f]{64}$/;

/** ISO 3166-1 alpha-2, officially assigned codes. */
export const COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO " +
  "JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR " +
  "MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO " +
  "RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV " +
  "TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");
const COUNTRY_SET = new Set(COUNTRY_CODES);

export type ProfileMeta = { pfp: string; bio: string; flag: string };
export const EMPTY_META: ProfileMeta = { pfp: "", bio: "", flag: "" };

// C0/C1 controls (newlines too: the bio is one line), zero-width, bidi embeddings/overrides/isolates, BOM.
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Canonical bio text. The server rejects a posted bio that isn't already canonical (it's part of the signed message). */
export function sanitizeBio(s: unknown): string {
  return String(s ?? "").normalize("NFC").replace(/[\r\n\t]+/g, " ").replace(STRIP, "").replace(/\s+/g, " ").trim();
}
export const bioLength = (s: string) => Array.from(s).length;
export const normalizeFlag = (s: unknown) => String(s ?? "").trim().toUpperCase();
export const isFlag = (s: string) => s === "" || COUNTRY_SET.has(s);
export const isPfpId = (s: string) => s === "" || PFP_ID_RE.test(s);
export const pfpUrl = (id: string) => (PFP_ID_RE.test(id) ? `/api/image/${id}` : "");

/** null when valid, else a short reason. Expects canonical values (sanitizeBio / normalizeFlag). */
export function validateMeta(m: ProfileMeta): string | null {
  if (bioLength(m.bio) > BIO_MAX) return `Bio: max ${BIO_MAX} characters.`;
  if (!isFlag(m.flag)) return "Unknown flag.";
  if (!isPfpId(m.pfp)) return "Invalid picture.";
  return null;
}

/** Signed by the wallet; verified by /api/profile/meta. Covers every field so a signature can't be reused for other content. */
export const profileMetaMessage = (address: string, m: ProfileMeta, nonce: string) =>
  `DISCIPLE profile update\n\nWallet: ${address.toLowerCase()}\nPicture: ${m.pfp || "none"}\nFlag: ${m.flag || "none"}\nBio: ${m.bio || "none"}\nNonce: ${nonce}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;
