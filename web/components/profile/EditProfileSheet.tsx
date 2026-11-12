"use client";

import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { BIO_MAX, BIO_RAW_MAX, EMPTY_META, bioLength, pfpUrl, sanitizeBio, type ProfileMeta } from "@/lib/profileMeta";
import { saveProfileMeta, uploadPfp } from "@/lib/profileMetaClient";
import { onPrivy, privyAccount } from "@/lib/aa/session";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Sheet from "./Sheet";
import IdentitySigil from "./IdentitySigil";
import { NO_IDENTITY } from "@/lib/identity";
import { PencilGlyph, TrashGlyph, XGlyph } from "./Glyphs";

/** Edit profile copy (profile r3 README copy list). */
export const EDIT_COPY = {
  title: "Edit profile",
  addBanner: "Add a banner",
  bio: "Bio",
  bioPlaceholder: "Tell people who you are.",
  x: "X",
  xConnect: "Connect your X account",
  xButton: "Connect X",
  xSoon: "Linking accounts is coming soon.",
  save: "Save",
  changePicture: "Change picture",
  changeBanner: "Change banner",
  removeBanner: "Remove banner",
} as const;

const same = (a: ProfileMeta, b: ProfileMeta) =>
  a.pfp === b.pfp && (a.banner || "") === (b.banner || "") && sanitizeBio(a.bio) === sanitizeBio(b.bio);

/**
 * Edit profile (profile r3): picture (pencil over the avatar), banner (add / change / remove), bio (160 characters) and
 * X. One Save. Username, display name, title and guild are not here (the username lives in Settings).
 * Picture and banner both go through /api/moderate-image (same store, same checks); picture / banner / bio are one
 * signed write (/api/profile/meta). Desktop modal / phone bottom sheet (Sheet).
 * X: shows the X account linked to your sign-in (Privy) when there is one. Linking a new X account from here is not
 * wired yet (no Privy link flow in the app), so Connect X stays off with a plain note.
 */
export default function EditProfileSheet({ open, onClose, wallet, meta, focus }: {
  open: boolean; onClose: (saved?: boolean) => void; wallet: string | null; meta: ProfileMeta; focus?: "bio" | null;
}) {
  const [draft, setDraft] = useState<ProfileMeta>(EMPTY_META);
  const [busy, setBusy] = useState<"" | "pfp" | "banner" | "save">("");
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [xUser, setXUser] = useState<string | null>(null);
  const [xNote, setXNote] = useState(false);
  const pfpFile = useRef<HTMLInputElement>(null);
  const bannerFile = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...EMPTY_META, ...meta }); setErr(""); setConfirm(false); setXNote(false);
    if (focus === "bio") requestAnimationFrame(() => bioRef.current?.focus());
  }, [open, meta, focus]);
  useEffect(() => { const read = () => setXUser(privyAccount()?.xUsername ?? null); read(); return onPrivy(read); }, []);

  const bioLen = bioLength(sanitizeBio(draft.bio));
  const dirty = !same(draft, meta);
  const valid = bioLen <= BIO_MAX;
  const tryClose = () => { if (dirty && !busy) setConfirm(true); else onClose(); };

  async function pick(kind: "pfp" | "banner", f: File | undefined) {
    if (!f) return;
    setBusy(kind); setErr("");
    const r = await uploadPfp(f);
    setBusy("");
    if (r.id) setDraft((d) => ({ ...d, [kind]: r.id! }));
    else setErr(r.reason || C["edit.pfp.error.failed"]);
    const el = kind === "pfp" ? pfpFile.current : bannerFile.current;
    if (el) el.value = "";
  }

  async function save() {
    setBusy("save"); setErr("");
    // titles are out of v1: a save never sets one; the flag (off in V1) is passed through untouched
    const r = await saveProfileMeta({ ...draft, bio: sanitizeBio(draft.bio), title: "" }, wallet);
    setBusy("");
    if (!r.ok) { setErr(r.reason || C["edit.error.save"]); return; }
    onClose(true);
  }

  const img = pfpUrl(draft.pfp), banner = pfpUrl(draft.banner ?? "");
  return (
    <Sheet open={open} onClose={tryClose} label={EDIT_COPY.title} className="p5-modal p5-edit" testId="edit-profile">
      <header className="p5-mhead">
        <h2>{EDIT_COPY.title}</h2>
        <button type="button" className="p5-icon" aria-label="Close" onClick={tryClose}><Icon name="close" size={18} /></button>
      </header>

      {confirm ? (
        <div className="p5-confirm" role="alertdialog" aria-label={C["edit.discard.title"]}>
          <p>{C["edit.discard.title"]}</p>
          <div className="p5-actions">
            <button type="button" className="p5-btn" data-autofocus onClick={() => setConfirm(false)}>{C["edit.discard.keep"]}</button>
            <button type="button" className="p5-btn primary" onClick={() => onClose()}>{C["edit.discard.confirm"]}</button>
          </div>
        </div>
      ) : (
        <form className="p5-edit-body" onSubmit={(e) => { e.preventDefault(); if (dirty && valid && !busy) void save(); }}>
          <input ref={pfpFile} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick("pfp", e.target.files?.[0])} data-testid="pfp-file" />
          <input ref={bannerFile} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick("banner", e.target.files?.[0])} data-testid="banner-file" />
          <div className="p5-ebanner-wrap">
            {banner ? (
              <div className="p5-ebanner" style={{ backgroundImage: `url(${withBase(banner)})` }} data-testid="edit-banner">
                <div className="p5-ebtns">
                  <button type="button" className="p5-icon dark" aria-label={EDIT_COPY.removeBanner} disabled={!!busy} onClick={() => setDraft((d) => ({ ...d, banner: "" }))}><TrashGlyph size={16} /></button>
                  <button type="button" className="p5-icon dark" aria-label={EDIT_COPY.changeBanner} disabled={!!busy} onClick={() => bannerFile.current?.click()}><PencilGlyph size={16} /></button>
                </div>
              </div>
            ) : (
              <button type="button" className="p5-ebanner none" disabled={!!busy} onClick={() => bannerFile.current?.click()} data-testid="add-banner">
                {busy === "banner" ? C["edit.saving"] : <><Icon name="plus" size={16} /> {EDIT_COPY.addBanner}</>}
              </button>
            )}
            <button type="button" className="p5-epfp" aria-label={EDIT_COPY.changePicture} disabled={!!busy} onClick={() => pfpFile.current?.click()} data-testid="edit-pfp">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {img ? <img src={withBase(img)} alt="" width={64} height={64} /> : <IdentitySigil id={NO_IDENTITY.primary.id} size={40} tip={false} />}
              <span className="pen">{busy === "pfp" ? "…" : <PencilGlyph size={16} />}</span>
            </button>
          </div>

          <label className="p5-fld">
            <span className="lab">{EDIT_COPY.bio}</span>
            <textarea ref={bioRef} className="p5-inp ta" rows={3} maxLength={BIO_RAW_MAX} value={draft.bio} placeholder={EDIT_COPY.bioPlaceholder}
              onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value.replace(/[\r\n]+/g, " ") }))} data-testid="edit-bio" />
            <span className="p5-help-row">
              {bioLen > BIO_MAX ? <span className="p5-err" role="alert">{C["edit.bio.error.length"]}</span> : <span />}
              <span className={`p5-count ${bioLen > BIO_MAX ? "bad" : ""}`}>{bioLen}/{BIO_MAX}</span>
            </span>
          </label>

          <div className="p5-fld" role="group" aria-label={EDIT_COPY.x}>
            <span className="lab">{EDIT_COPY.x}</span>
            <div className="p5-xrow" data-testid="edit-x">
              <XGlyph size={18} />
              {xUser ? <span className="u">@{xUser}</span> : <>
                <span className="u muted">{EDIT_COPY.xConnect}</span>
                {/* Not wired: the app has no Privy "link X" flow yet, and this change does not add a new login path. */}
                <button type="button" className="p5-btn sm" aria-disabled="true" data-testid="connect-x" onClick={() => setXNote(true)}>{EDIT_COPY.xButton}</button>
              </>}
            </div>
            {xNote && !xUser && <span className="p5-fine" role="status">{EDIT_COPY.xSoon}</span>}
          </div>

          {err && <p className="p5-err" role="alert">{err}</p>}
          <button type="submit" className="p5-btn primary wide" disabled={!dirty || !valid || !!busy}>{busy === "save" ? C["edit.saving"] : EDIT_COPY.save}</button>
        </form>
      )}
    </Sheet>
  );
}
