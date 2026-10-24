"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { identityRuleText, type IdentityId } from "@/lib/identity";
import { earnedTitlesFor, profileStatsSeed, shownTitle, titleDef } from "@/lib/titles";
import { withBase } from "@/lib/base-path";
import { checkUsername, claimUsername, fetchUsernameStatus, localUsername, normalizeUsername, validateUsername } from "@/lib/profile";
import { formatLocalWhen } from "@/lib/usernameCooldown";
import { BIO_MAX, BIO_RAW_MAX, EMPTY_META, bioLength, pfpUrl, sanitizeBio, type ProfileMeta } from "@/lib/profileMeta";
import { saveProfileMeta, uploadPfp } from "@/lib/profileMetaClient";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Sheet from "./Sheet";
import FlagPicker from "./FlagPicker";

const same = (a: ProfileMeta, b: ProfileMeta) => a.pfp === b.pfp && a.flag === b.flag && sanitizeBio(a.bio) === sanitizeBio(b.bio) && (a.title || "") === (b.title || "");

/**
 * Edit profile: picture · username · bio · flag (country or coin community), one Save. Username: one change per 24h,
 * enforced by the server; the field is disabled until the server's nextAllowedAt. Desktop modal / mobile bottom sheet (Sheet).
 * Username keeps its own signed claim (/api/profile/username); picture / bio / flag share one signed write
 * (/api/profile/meta). Pictures pass /api/moderate-image before they can be saved.
 */
export default function EditProfileSheet({ open, onClose, wallet, meta, focus }: {
  open: boolean; onClose: (saved?: boolean) => void; wallet: string | null; meta: ProfileMeta; focus?: "bio" | null;
}) {
  const [draft, setDraft] = useState<ProfileMeta>(EMPTY_META);
  const [me, setMe] = useState("");
  const [name, setName] = useState("");
  const [nameStatus, setNameStatus] = useState<{ ok: boolean; text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "save">("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [nextNameAt, setNextNameAt] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const u = localUsername();
    setMe(u); setName(u); setDraft(meta); setErr(""); setNote(""); setConfirm(false); setNameStatus(null);
    if (focus === "bio") requestAnimationFrame(() => bioRef.current?.focus());
  }, [open, meta, focus]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setNextNameAt(null);
    void fetchUsernameStatus(wallet).then((s) => {
      if (!alive) return;
      setNextNameAt(s.nextAllowedAt);
      // This browser may not know the claimed name yet (other device / cleared storage): prefill it from the registry.
      if (s.username && !localUsername()) { setMe(s.username); setName(s.username); }
    });
    return () => { alive = false; };
  }, [open, wallet]);
  const nameLocked = nextNameAt != null && nextNameAt > Date.now();

  const nameChanged = !!name && normalizeUsername(name) !== me;
  useEffect(() => {
    if (!open || !nameChanged) { setNameStatus(null); return; }
    const bad = validateUsername(name);
    if (bad) { setNameStatus({ ok: false, text: bad, bad: true }); return; }
    setNameStatus({ ok: false, text: C["edit.username.checking"] });
    let alive = true;
    const t = setTimeout(async () => {
      const r = await checkUsername(name);
      if (alive) setNameStatus({ ok: r.available, text: r.available ? `Available${r.reason ? ` (${r.reason})` : ""}` : r.reason || "Taken" });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [name, nameChanged, open]);

  const bioLen = bioLength(sanitizeBio(draft.bio));
  // Titles: earned ones only (lib/titles, same computation the server checks). A rename changes the (sample) stats
  // seed, so the list follows the name being saved.
  const earned = useMemo(() => earnedTitlesFor(profileStatsSeed(nameChanged && nameStatus?.ok ? normalizeUsername(name) : me, wallet)), [nameChanged, nameStatus?.ok, name, me, wallet]);
  const titleNow = shownTitle(draft.title, earned);
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
    else setErr(r.reason || C["edit.pfp.error.failed"]);
    if (file.current) file.current.value = "";
  }

  async function save() {
    setBusy("save"); setErr("");
    if (nameChanged) {
      setNote(C["edit.sign"]);
      const r = await claimUsername(name, wallet);
      setNote("");
      if (!r.ok) { if (r.nextAllowedAt) { setNextNameAt(r.nextAllowedAt); setName(me); } setBusy(""); setErr(r.reason || C["edit.error.save"]); return; }
      setMe(normalizeUsername(name));
    }
    if (metaChanged) {
      const t = draft.title && earned.includes(draft.title as IdentityId) ? draft.title : "";
      const r = await saveProfileMeta({ ...draft, bio: sanitizeBio(draft.bio), title: t }, wallet);
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
                disabled={nameLocked} aria-describedby="pf-name-cooldown" onChange={(e) => setName(e.target.value.toLowerCase())} />
            </span>
            <span className="pf-help" id="pf-name-cooldown" data-testid="username-cooldown">
              {nameLocked ? C["username.cooldown.note"](formatLocalWhen(nextNameAt!)) : C["username.cooldown.rule"]}
            </span>
            <span className="pf-help-row">
              {nameStatus ? <span className={nameStatus.ok ? "pf-ok" : nameStatus.bad ? "pf-bad" : "pf-help"} role={nameStatus.ok ? "status" : undefined}
                  data-testid="username-status">{nameStatus.text}</span>
                : name && !nameChanged ? <span className="pf-help">That&apos;s you.</span> : <span />}
              <span className="pf-help pf-mono">{name.length}/20</span>
            </span>
          </label>

          <label className="pf-field">
            <span className="pf-field-label">{C["edit.bio.label"]}</span>
            <textarea ref={bioRef} className="pf-input pf-textarea" rows={3} maxLength={BIO_RAW_MAX} value={draft.bio} placeholder={C["edit.bio.placeholder"]}
              onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value.replace(/[\r\n]+/g, " ") }))} />
            <span className="pf-help-row">
              {bioLen > BIO_MAX ? <span className="pf-bad" role="alert">{C["edit.bio.error.length"]}</span> : <span className="pf-help">{C["edit.bio.helper"]} {C["edit.bio.helper.links"]}</span>}
              <span className={`pf-help pf-mono ${bioLen > BIO_MAX ? "pf-bad" : ""}`}>{bioLen}/{BIO_MAX}</span>
            </span>
          </label>

          <div className="pf-field" role="group" aria-label={C["edit.flag.label.any"]}>
            <span className="pf-field-label">{C["edit.flag.label.any"]}</span>
            <FlagPicker value={draft.flag} onChange={(id) => setDraft((d) => ({ ...d, flag: id }))} />
            <span className="pf-help">{C["edit.flag.helper.any"]}</span>
          </div>

          <fieldset className="pf-field pf-title-pick" data-testid="title-picker">
            <legend className="pf-field-label">{C["edit.title.label"]}</legend>
            {earned.length ? (
              <div className="pf-title-opts" role="radiogroup" aria-label={C["edit.title.label"]}>
                {earned.map((id) => (
                  <label key={id} className={`pf-title-opt ${titleNow === id ? "on" : ""}`}>
                    <input type="radio" name="pf-title" value={id} checked={titleNow === id} onChange={() => setDraft((d) => ({ ...d, title: id }))} />
                    <span className="pf-title-opt-text"><strong>{titleDef(id)?.label}</strong><span className="pf-help">{identityRuleText(id)}</span></span>
                  </label>
                ))}
              </div>
            ) : <span className="pf-help">{C["edit.title.empty"]}</span>}
            <span className="pf-help-row">
              <span className="pf-help">{C["edit.title.helper"]}</span>
              <a href={withBase("/achievements#titles")} className="pf-help pf-link">{C["edit.title.more"]}</a>
            </span>
          </fieldset>

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
