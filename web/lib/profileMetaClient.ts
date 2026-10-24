/**
 * Client side of /api/profile/meta (picture / bio / flag). Same signed-nonce pattern as the username claim (lib/profile).
 * Pictures go through /api/moderate-image first; only an "allow" verdict yields a stored image id we can save.
 * Static preview (no API): kept in this browser only, like usernames.
 */
import { IS_STATIC_PREVIEW } from "./base-path";
import { notifyProfileChanged, signWalletMessage } from "./profile";
import { PFP_ERROR, pfpFailure, pfpPrecheck, shrinkForUpload } from "./pfpUpload";
import { EMPTY_META, normalizeFlag, PFP_ID_RE, profileMetaMessage, sanitizeBio, validateMeta, type ProfileMeta } from "./profileMeta";

const LOCAL_KEY = "disciple.profileMeta";
const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

function localMeta(): ProfileMeta {
  try { return { ...EMPTY_META, ...(JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") as Partial<ProfileMeta>) }; } catch { return { ...EMPTY_META }; }
}

export async function fetchProfileMeta(address: string | null | undefined): Promise<ProfileMeta> {
  if (IS_STATIC_PREVIEW) return localMeta();
  if (!isAddr(address)) return { ...EMPTY_META };
  try {
    const j = (await (await fetch(`/api/profile/meta?address=${address.toLowerCase()}`, { cache: "no-store" })).json()) as Partial<ProfileMeta>;
    return { pfp: j.pfp || "", bio: j.bio || "", flag: j.flag || "" };
  } catch { return { ...EMPTY_META }; }
}

export async function saveProfileMeta(input: ProfileMeta, address: string | null): Promise<{ ok: boolean; reason?: string }> {
  const m: ProfileMeta = { pfp: input.pfp, bio: sanitizeBio(input.bio), flag: normalizeFlag(input.flag) };
  const bad = validateMeta(m);
  if (bad) return { ok: false, reason: bad };
  if (IS_STATIC_PREVIEW) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(m)); } catch { /* ignore */ } notifyProfileChanged(); return { ok: true }; }
  if (!isAddr(address)) return { ok: false, reason: "Sign in to see this." };
  const a = address.toLowerCase();
  try {
    const { nonce } = (await (await fetch(`/api/profile/meta?nonce=1&address=${a}`, { cache: "no-store" })).json()) as { nonce?: string };
    if (!nonce) return { ok: false, reason: "Could not reach the profile service." };
    const signed = await signWalletMessage(profileMetaMessage(a, m, nonce), a);
    if (!signed) return { ok: false, reason: "Signature declined." };
    const r = await fetch("/api/profile/meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: a, ...m, nonce, ...signed }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    if (!r.ok || !j.ok) return { ok: false, reason: j.reason || "Could not save." };
  } catch { return { ok: false, reason: "Could not reach the profile service." }; }
  notifyProfileChanged();
  return { ok: true };
}

/** Upload a picture through the moderation path (shrunk in the browser first). Resolves the stored image id, or a plain reason. */
export async function uploadPfp(file: File): Promise<{ id?: string; reason?: string }> {
  if (IS_STATIC_PREVIEW) return { reason: "Static preview: uploads need the server." };
  const pre = pfpPrecheck(file);
  if (pre) { console.warn("[disciple] pfp: refused before upload", { kind: pre, type: file.type, bytes: file.size }); return { reason: PFP_ERROR[pre] }; }
  const blob = await shrinkForUpload(file);
  const fd = new FormData();
  fd.append("file", blob, file.name || "picture");
  try {
    const r = await fetch("/api/moderate-image", { method: "POST", body: fd });
    const j = (await r.json().catch(() => null)) as { verdict?: string; imageUri?: string; error?: string } | null;
    const id = j?.imageUri?.split("/").pop() || "";
    if (r.ok && j?.verdict === "allow" && PFP_ID_RE.test(id)) return { id };
    const kind = pfpFailure(r.status, j);
    console.warn("[disciple] pfp upload failed", { kind, status: r.status, verdict: j?.verdict, error: j?.error, sentBytes: blob.size, sentType: blob.type, fileBytes: file.size });
    return { reason: PFP_ERROR[kind] };
  } catch (e) {
    console.warn("[disciple] pfp upload: network error", e);
    return { reason: PFP_ERROR.failed };
  }
}
