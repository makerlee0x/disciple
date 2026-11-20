"use client";

import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { BIO_MAX, BIO_RAW_MAX, DISPLAY_NAME_MAX, DISPLAY_NAME_RAW_MAX, EMPTY_META, bioLength, pfpUrl, sanitizeBio, sanitizeDisplayName, type ProfileMeta } from "@/lib/profileMeta";
import { saveProfileMeta, uploadPfp } from "@/lib/profileMetaClient";
import XLinkControl from "./XLinkControl";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Sheet from "./Sheet";
import IdentitySigil from "./IdentitySigil";
import { NO_IDENTITY } from "@/lib/identity";
import { PencilGlyph, XGlyph } from "./Glyphs";
import { UsernameField, useUsernameDraft } from "./UsernameRow";
import HolderWallets from "@/components/nft/HolderWallets";
import NftPicker from "@/components/nft/NftPicker";
import { EMPTY_HOLDER, fetchHolder } from "@/lib/nft/client";
import { DISCIPLES_LIVE, type HolderStatus } from "@/lib/nft/config";
import { isNativeApp } from "@/lib/native";
import SquareCrop, { cropSquare } from "@/components/create/SquareCrop";
import { PFP_ERROR, pfpPrecheck } from "@/lib/pfpUpload";

/** Edit profile copy (profile r3 README copy list). */
export const EDIT_COPY = {
  title: "Edit profile",
  cropUse: "Use photo",
  cropCancel: "Cancel",
  addBanner: "Add a banner",
  name: "Name",
  bio: "Bio",
  bioPlaceholder: "Tell people who you are.",
  x: "X account",
  xConnect: "Not linked",
  xButton: "Connect X",
  links: "Linked accounts",
  link: "Link",
  save: "Save changes",
  changePicture: "Change picture",
  changeBanner: "Change banner",
  removeBanner: "Remove banner",
} as const;

const same = (a: ProfileMeta, b: ProfileMeta) =>
  a.pfp === b.pfp && (a.banner || "") === (b.banner || "") && sanitizeBio(a.bio) === sanitizeBio(b.bio)
  && sanitizeDisplayName(a.name) === sanitizeDisplayName(b.name);

/**
 * Edit profile (profile r3): picture (pencil over the avatar), banner (add / change / remove), bio (160 characters) and
 * display name + username, X. One Save (claims a changed username first, then writes picture / banner / name / bio). The
 * display name (spaces allowed) is profile meta; the call sign stays the a–z 0–9 _ @handle. Title and guild are not here. Username moved back here from Settings (lee, Nov 11).
 * Picture and banner both go through /api/moderate-image (same store, same checks); picture / banner / bio are one
 * signed write (/api/profile/meta). Desktop modal / phone bottom sheet (Sheet).
 * X: link / unlink a verified X account through X's own OAuth (components/profile/XLinkControl, /api/x).
 */
export default function EditProfileSheet({ open, onClose, wallet, meta, focus, handle, level }: {
  open: boolean; /** saved: true, or the line to flash instead of the usual "Saved" */ onClose: (saved?: boolean | string) => void; wallet: string | null; meta: ProfileMeta; focus?: "bio" | null;
  /** the name on the banner now, shown in the cockpit strip until a new call sign is typed */
  handle?: string;
  /** "Level 13 · Ace" under the name in the cockpit strip */
  level?: string;
}) {
  const [draft, setDraft] = useState<ProfileMeta>(EMPTY_META);
  const [busy, setBusy] = useState<"" | "pfp" | "banner" | "save">("");
  const [err, setErr] = useState("");
  const pfpFile = useRef<HTMLInputElement>(null);
  const bannerFile = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  // Disciple NFTs (maker 2026-11-17): holder wallets + Connect NFT. Web only: the iPhone app has no Solana wallet to sign with.
  const [holder, setHolder] = useState<HolderStatus>(EMPTY_HOLDER);
  const [picking, setPicking] = useState(false);
  const [web, setWeb] = useState(false);
  useEffect(() => setWeb(!isNativeApp()), []);
  useEffect(() => {
    if (!open || !wallet) return;
    let alive = true;
    void fetchHolder(wallet).then((h) => { if (alive) setHolder(h); });
    return () => { alive = false; };
  }, [open, wallet]);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...EMPTY_META, ...meta }); setErr(""); setPicking(false);
    if (focus === "bio") requestAnimationFrame(() => bioRef.current?.focus());
  }, [open, meta, focus]);

  const uname = useUsernameDraft(wallet, open);
  const bioLen = bioLength(sanitizeBio(draft.bio));
  const nameLen = bioLength(sanitizeDisplayName(draft.name));
  const metaDirty = !same(draft, meta);
  const dirty = metaDirty || uname.changed;
  // a call sign that can't be claimed (taken / bad) must not hold back the picture and bio (maker 2026-11-16: "bio didn't
  // save" while the call sign said taken). Save then writes the rest and leaves the call sign as it was.
  const nameOk = !uname.changed || !!uname.status?.ok;
  const valid = bioLen <= BIO_MAX && nameLen <= DISPLAY_NAME_MAX && (nameOk || metaDirty);
  // no "Discard changes?" step (maker 2026-11-16: "everyone knows if you don't click save it doesn't save"): X / Back /
  // Escape / tapping outside just close, and unsaved edits are dropped
  const tryClose = () => onClose();

  // picture: pick → drag-to-crop square (maker 2026-11-20) → upload the 512 px square, so every avatar shows the same framing
  const [crop, setCrop] = useState<{ img: HTMLImageElement; pos: { x: number; y: number }; name: string } | null>(null);
  async function pickPfp(f: File | undefined) {
    if (pfpFile.current) pfpFile.current.value = "";
    if (!f) return;
    setErr("");
    const pre = pfpPrecheck(f);
    if (pre) { setErr(PFP_ERROR[pre]); return; }
    const url = URL.createObjectURL(f);
    const im = new Image(); im.src = url;
    try { await im.decode(); } catch { URL.revokeObjectURL(url); setErr(PFP_ERROR.format); return; }
    setCrop({ img: im, pos: { x: 0.5, y: 0 }, name: (f.name || "picture").replace(/\.[^.]*$/, "") });
  }
  function closeCrop() { if (crop) URL.revokeObjectURL(crop.img.src); setCrop(null); }
  async function applyCrop() {
    if (!crop) return;
    const uri = cropSquare(crop.img, crop.pos, 512);
    const blob = await (await fetch(uri)).blob();
    const ext = blob.type === "image/webp" ? "webp" : "png";
    closeCrop();
    await pick("pfp", new File([blob], `${crop.name}.${ext}`, { type: blob.type }));
  }

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
    // the call sign can't be claimed as typed (too short / taken / reserved): the rest still saves, and the toast says why
    let skipName: string | false = uname.changed && !uname.status?.ok ? C["edit.username.skipped"](uname.status?.text || C["edit.username.taken"]) : false;
    if (uname.changed && !skipName) {
      const u = await uname.claim();
      // a refused claim (taken a moment ago, 24h cooldown, reserved) must not drop the new picture / bio either
      // (maker 2026-11-16: "uploading a pfp didn't work"): save those, then say why the call sign stayed
      if (!u.ok && !metaDirty) { setBusy(""); setErr(u.reason || C["edit.error.save"]); return; }
      if (!u.ok) skipName = C["edit.username.skipped"](u.reason || C["edit.error.save"]);
      if (u.ok && !metaDirty) { setBusy(""); onClose(true); return; }
    }
    // titles are out of v1: a save never sets one; the flag (off in V1) is passed through untouched
    const r = await saveProfileMeta({ ...draft, bio: sanitizeBio(draft.bio), name: sanitizeDisplayName(draft.name), title: "" }, wallet);
    setBusy("");
    if (!r.ok) { setErr(r.reason || C["edit.error.save"]); return; }
    onClose(skipName || true);
  }

  // Connect X leaves the page (X / Privy sign-in), so unsaved picture / banner / bio edits are saved first (maker
  // 2026-11-16: picked a picture, hit Connect X, came back and the picture was gone).
  async function saveBeforeX(): Promise<boolean> {
    if (!metaDirty || bioLen > BIO_MAX || nameLen > DISPLAY_NAME_MAX) return true;
    setBusy("save"); setErr("");
    const r = await saveProfileMeta({ ...draft, bio: sanitizeBio(draft.bio), name: sanitizeDisplayName(draft.name), title: "" }, wallet);
    setBusy("");
    if (!r.ok) { setErr(r.reason || C["edit.error.save"]); return false; }
    return true;
  }

  const img = pfpUrl(draft.pfp);
  return (
    <Sheet open={open} onClose={tryClose} label={EDIT_COPY.title} className="p5-modal p5-edit" testId="edit-profile">
      {/* the cockpit strip (Hangar popups v2): your picture and name the way they look on your banner */}
      <header className="p5-epstrip">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="bg" src={withBase("/hangar/cockpit-1200.webp")} alt="" aria-hidden />
        <span className="sc" aria-hidden />
        <button type="button" className="p5-icon p5-phone" aria-label="Back" onClick={tryClose}><Icon name="chevron-left" size={20} /></button>
        <h2 className="k">{EDIT_COPY.title}</h2>
        <button type="button" className="p5-icon p5-desk" aria-label="Close" onClick={tryClose}><Icon name="close" size={18} /></button>
        <div className="who">
          <button type="button" className="p5-epfp hg-epfp" aria-label={EDIT_COPY.changePicture} disabled={!!busy} onClick={() => pfpFile.current?.click()} data-testid="edit-pfp">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {img ? <img className="pfp-img" src={withBase(img)} alt="" width={84} height={84} /> : <IdentitySigil id={NO_IDENTITY.primary.id} size={44} tip={false} />}
            <span className="pen">{busy === "pfp" ? "…" : <PencilGlyph size={14} />}</span>
          </button>
          <div className="nm">
            <b>{draft.name?.trim() || uname.name || (handle || "").replace(/^@/, "")}</b>
            {level && <span>{level}</span>}
            {web && wallet && DISCIPLES_LIVE && <button type="button" className="nft-connect" disabled={!!busy} aria-pressed={picking} onClick={() => setPicking((v) => !v)} data-testid="connect-nft">Connect NFT</button>}
          </div>
        </div>
      </header>
      <input ref={pfpFile} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pickPfp(e.target.files?.[0])} data-testid="pfp-file" />

        {crop ? (
          <div className="p5-crop" data-testid="pfp-crop">
            <div className="p5-crop-frame">
              <SquareCrop img={crop.img} pos={crop.pos} onChange={(pos) => setCrop((c) => (c ? { ...c, pos } : c))} size={240} />
              <span className="p5-crop-ring" aria-hidden />
            </div>
            <div className="p5-crop-act">
              <button type="button" className="p5-btn" onClick={closeCrop}>{EDIT_COPY.cropCancel}</button>
              <button type="button" className="p5-btn primary p5-gold" onClick={() => void applyCrop()} data-testid="pfp-crop-use">{EDIT_COPY.cropUse}</button>
            </div>
          </div>
        ) : picking && wallet ? (
          <NftPicker wallet={wallet} status={holder} onStatus={setHolder} onClose={() => setPicking(false)}
            onPicked={(id) => { setDraft((d) => ({ ...d, pfp: id })); setPicking(false); }} />
        ) : (
        <form className="p5-edit-body" onSubmit={(e) => { e.preventDefault(); if (dirty && valid && !busy) void save(); }}>
          <label className="p5-fld">
            <span className="lab">{EDIT_COPY.name} <em className={nameLen > DISPLAY_NAME_MAX ? "bad" : ""}>{nameLen} / {DISPLAY_NAME_MAX}</em></span>
            <input className="p5-inp" value={draft.name ?? ""} maxLength={DISPLAY_NAME_RAW_MAX} autoComplete="off" disabled={!!busy}
              placeholder={uname.me || (handle || "").replace(/^@/, "")}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.replace(/[\r\n]+/g, " ") }))} data-testid="edit-display-name" />
          </label>

          <UsernameField u={uname} disabled={!!busy} />

          <label className="p5-fld">
            <span className="lab">{EDIT_COPY.bio} <em className={bioLen > BIO_MAX ? "bad" : ""}>{bioLen} / {BIO_MAX}</em></span>
            <textarea ref={bioRef} className="p5-inp ta" rows={3} maxLength={BIO_RAW_MAX} value={draft.bio} placeholder={EDIT_COPY.bioPlaceholder}
              onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value.replace(/[\r\n]+/g, " ") }))} data-testid="edit-bio" />
            {bioLen > BIO_MAX && <span className="p5-err" role="alert">{C["edit.bio.error.length"]}</span>}
          </label>

          {/* X + holder wallets: three compact tiles on one row (maker 2026-11-18). */}
          <XLinkControl wallet={wallet} btnClass="p5-btn sm" connectLabel={EDIT_COPY.link} beforeConnect={saveBeforeX}
            fallback={web && (
              <div className="p5-fld" role="group" aria-label={EDIT_COPY.links}>
                <span className="lab">{EDIT_COPY.links}</span>
                <div className="p5-links"><HolderWallets wallet={wallet} status={holder} onChange={setHolder} tiles /></div>
              </div>
            )}
            render={({ handle, action, note }) => (
            <div className="p5-fld" role="group" aria-label={EDIT_COPY.links}>
              <span className="lab">{EDIT_COPY.links}</span>
              <div className="p5-links">
                <div className="p5-link" data-testid="edit-x">
                  <div className="p5-link-top">
                    <span className="p5-link-ico x" aria-hidden><XGlyph size={14} /></span>
                    <span className="u mono">{handle ? `@${handle}` : "X"}</span>
                  </div>
                  {action}
                </div>
                {web && <HolderWallets wallet={wallet} status={holder} onChange={setHolder} tiles />}
                {note && <span className="p5-fine p5-link-wide" role="status">{note}</span>}
              </div>
            </div>
          )} />

          {err && <p className="p5-err" role="alert">{err}</p>}
          <button type="submit" className="p5-btn primary wide p5-gold" disabled={!dirty || !valid || !!busy}>{busy === "save" ? C["edit.saving"] : EDIT_COPY.save}</button>
        </form>
        )}
    </Sheet>
  );
}
