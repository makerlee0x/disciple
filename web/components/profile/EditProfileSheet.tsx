"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { checkUsername, claimUsername, localUsername, normalizeUsername, validateUsername } from "@/lib/profile";
import { BIO_MAX, COUNTRY_CODES, EMPTY_META, bioLength, pfpUrl, sanitizeBio, type ProfileMeta } from "@/lib/profileMeta";
import { saveProfileMeta, uploadPfp } from "@/lib/profileMetaClient";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Sheet from "./Sheet";
import Flag, { countryName } from "./Flag";

const same = (a: ProfileMeta, b: ProfileMeta) => a.pfp === b.pfp && a.flag === b.flag && sanitizeBio(a.bio) === sanitizeBio(b.bio);

/**
 * Edit profile: picture · username · bio · country flag, one Save. Desktop modal / mobile bottom sheet (Sheet).
 * Username keeps its own signed claim (/api/profile/username); picture / bio / flag share one signed write
 * (/api/profile/meta). Pictures pass /api/moderate-image before they can be saved.
 */
export default function EditProfileSheet({ open, onClose, wallet, meta, focus }: {
  open: boolean; onClose: (saved?: boolean) => void; wallet: string | null; meta: ProfileMeta; focus?: "bio" | null;
}) {
  const [draft, setDraft] = useState<ProfileMeta>(EMPTY_META);
  const [me, setMe] = useState("");
  const [name, setName] = useState("");
  const [nameStatus, setNameStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "save">("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const u = localUsername();
    setMe(u); setName(u); setDraft(meta); setErr(""); setNote(""); setConfirm(false); setNameStatus(null);
    if (focus === "bio") requestAnimationFrame(() => bioRef.current?.focus());
  }, [open, meta, focus]);

  const nameChanged = !!name && normalizeUsername(name) !== me;
  useEffect(() => {
    if (!open || !nameChanged) { setNameStatus(null); return; }
    const bad = validateUsername(name);
    if (bad) { setNameStatus({ ok: false, text: bad }); return; }
    setNameStatus({ ok: false, text: C["edit.username.checking"] });
    let alive = true;
    const t = setTimeout(async () => {
      const r = await checkUsername(name);
      if (alive) setNameStatus({ ok: r.available, text: r.available ? `Available${r.reason ? ` (${r.reason})` : ""}` : r.reason || "Taken" });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [name, nameChanged, open]);

  const countries = useMemo(() => COUNTRY_CODES.map((c) => ({ c, n: countryName(c) })).sort((a, b) => a.n.localeCompare(b.n)), []);
  const bioLen = bioLength(sanitizeBio(draft.bio));
  const metaChanged = !same(draft, meta);
  const dirty = metaChanged || nameChanged;
  const valid = bioLen <= BIO_MAX && (!nameChanged || !!nameStatus?.ok);

  const tryClose = () => { if (dirty && !busy) setConfirm(true); else onClose(); };
  const discard = () => onClose();

  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy("upload"); setErr("");
    const r = await uploadPfp(f);
    setBusy("");
    if (r.id) setDraft((d) => ({ ...d, pfp: r.id! }));
    else setErr(r.reason || "This image can't be used.");
    if (file.current) file.current.value = "";
  }

  async function save() {
    setBusy("save"); setErr("");
    if (nameChanged) {
      setNote(C["edit.sign"]);
      const r = await claimUsername(name, wallet);
      setNote("");
      if (!r.ok) { setBusy(""); setErr(r.reason || C["edit.error.save"]); return; }
      setMe(normalizeUsername(name));
    }
    if (metaChanged) {
      const r = await saveProfileMeta({ ...draft, bio: sanitizeBio(draft.bio) }, wallet);
      if (!r.ok) { setBusy(""); setErr(r.reason || C["edit.error.save"]); return; }
    }
    setBusy("");
    onClose(true);
  }

  const img = pfpUrl(draft.pfp);
  return (
    <Sheet open={open} onClose={tryClose} label={C["edit.title"]} className="pf-edit-sheet" testId="edit-profile">
      <header className="pf-edit-head">
        <h2>{C["edit.title"]}</h2>
        <button type="button" className="ds-btn pf-icon-btn" aria-label="Close" onClick={tryClose}><Icon name="close" size={16} /></button>
      </header>

      {confirm ? (
        <div className="pf-edit-confirm" role="alertdialog" aria-label={C["edit.discard.title"]}>
          <p>{C["edit.discard.title"]}</p>
          <div className="pf-edit-foot">
            <button type="button" className="ds-btn" data-autofocus onClick={() => setConfirm(false)}>{C["edit.discard.keep"]}</button>
            <button type="button" className="ds-btn pf-btn-primary" onClick={discard}>{C["edit.discard.confirm"]}</button>
          </div>
        </div>
      ) : (
        <form className="pf-edit-body" onSubmit={(e) => { e.preventDefault(); if (dirty && valid && !busy) void save(); }}>
          <fieldset className="pf-field pf-field-pfp" aria-label={C["edit.pfp.label"]}>
            <span className="pf-edit-pfp" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {img ? <img src={withBase(img)} alt="" width={72} height={72} /> : <Icon name="pilot" size={32} />}
            </span>
            <div className="pf-edit-pfp-actions">
              <div className="pf-row">
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} />
                <button type="button" className="ds-btn" disabled={!!busy} onClick={() => file.current?.click()}>{draft.pfp ? C["edit.pfp.change"] : C["edit.pfp.upload"]}</button>
                {draft.pfp && <button type="button" className="ds-btn pf-btn-text" disabled={!!busy} onClick={() => setDraft((d) => ({ ...d, pfp: "" }))}>{C["edit.pfp.remove"]}</button>}
              </div>
              <span className="pf-help">{C["edit.pfp.helper"]}</span>
            </div>
          </fieldset>

          <label className="pf-field">
            <span className="pf-field-label">{C["edit.username.label"]}</span>
            <span className="pf-input-wrap"><span className="muted">@</span>
              <input className="pf-input" value={name} maxLength={20} placeholder="your_name" autoComplete="off" spellCheck={false}
                onChange={(e) => setName(e.target.value.toLowerCase())} />
            </span>
            <span className="pf-help-row">
              {nameStatus ? <span className={nameStatus.ok ? "pf-ok" : "pf-help"} role={nameStatus.ok ? "status" : undefined}>{nameStatus.text}</span>
                : name && !nameChanged ? <span className="pf-help">That&apos;s you.</span> : <span />}
              <span className="pf-help pf-mono">{name.length}/20</span>
            </span>
          </label>

          <label className="pf-field">
            <span className="pf-field-label">{C["edit.bio.label"]}</span>
            <textarea ref={bioRef} className="pf-input pf-textarea" rows={3} maxLength={BIO_MAX * 2} value={draft.bio} placeholder={C["edit.bio.placeholder"]}
              onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value.replace(/[\r\n]+/g, " ") }))} />
            <span className="pf-help-row">
              {bioLen > BIO_MAX ? <span className="pf-bad" role="alert">{C["edit.bio.error.length"]}</span> : <span className="pf-help">{C["edit.bio.helper"]}</span>}
              <span className={`pf-help pf-mono ${bioLen > BIO_MAX ? "pf-bad" : ""}`}>{bioLen}/{BIO_MAX}</span>
            </span>
          </label>

          <label className="pf-field">
            <span className="pf-field-label">{C["edit.flag.label"]}</span>
            <span className="pf-input-wrap">
              {draft.flag ? <Flag cc={draft.flag} size={16} /> : null}
              <select className="pf-input pf-select" value={draft.flag} onChange={(e) => setDraft((d) => ({ ...d, flag: e.target.value }))}>
                <option value="">{C["edit.flag.none"]}</option>
                {countries.map(({ c, n }) => <option key={c} value={c}>{n}</option>)}
              </select>
            </span>
            <span className="pf-help">{C["edit.flag.helper"]}</span>
          </label>

          {note && <p className="pf-help" role="status">{note}</p>}
          {err && <p className="pf-bad" role="alert">{err}</p>}
          <div className="pf-edit-foot">
            <button type="button" className="ds-btn" disabled={busy === "save"} onClick={tryClose}>{C["edit.cancel"]}</button>
            <button type="submit" className="ds-btn pf-btn-primary" disabled={!dirty || !valid || !!busy}>{busy === "save" ? C["edit.saving"] : C["edit.save"]}</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
