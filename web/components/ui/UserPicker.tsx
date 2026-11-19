"use client";
/**
 * @user picker (maker 2026-11-19): type a Disciple @username (or a 0x address where `allowAddress`), see who it is
 * before anything moves. Shared by Cash send, the rocket / item Send sheet and the creator rewards redirect.
 * The picked card (picture, display name, @username, short wallet) is the recipient check, so it always shows.
 */
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { lookup, recentRecipients, recipientLabel, shortAddr, type Lookup, type Recipient } from "@/lib/send/recipient";

export const PICKER_COPY = {
  label: "Send to",
  ph: "username",
  phAddr: "@username or 0x…",
  paste: "Paste",
  recent: "Recent",
  none: (u: string) => `No pilot named @${u}`,
  self: "That's you.",
  bad: "That doesn't look like a username or a 0x address.",
  badUser: "Usernames are a–z, 0–9 and _.",
  clear: "Change",
} as const;

export function Avatar({ r, size = 40 }: { r: Pick<Recipient, "pfp" | "username" | "address">; size?: number }) {
  const ch = (r.username || r.address.slice(2) || "?")[0].toUpperCase();
  return (
    <span className="up-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {r.pfp ? <img src={/^https?:/.test(r.pfp) ? r.pfp : withBase(r.pfp)} alt="" width={size} height={size} /> : ch}
    </span>
  );
}

/** The recipient card: who gets it. Also used on the Sent receipt. */
export function RecipientCard({ r, onClear }: { r: Recipient; onClear?: () => void }) {
  return (
    <div className="up-card" data-testid="picker-found">
      <Avatar r={r} />
      <span className="up-who">
        <b>{r.name || recipientLabel(r)}</b>
        <span>{r.name && r.username ? <>@{r.username} · </> : null}<span className="r2-mono">{shortAddr(r.address)}</span></span>
      </span>
      {onClear && <button type="button" className="up-chg" onClick={onClear} data-testid="picker-clear">{PICKER_COPY.clear}</button>}
    </div>
  );
}

export default function UserPicker({ value, onChange, me, allowAddress = false, label = PICKER_COPY.label, id = "up-to" }: {
  value: Recipient | null;
  onChange: (r: Recipient | null) => void;
  me: string | null;
  allowAddress?: boolean;
  label?: string;
  id?: string;
}) {
  const [text, setText] = useState("");
  const [res, setRes] = useState<Lookup>({ state: "idle" });
  const [recent, setRecent] = useState<Recipient[]>([]);
  const seq = useRef(0);
  useEffect(() => { setRecent(recentRecipients().filter((r) => !me || r.address.toLowerCase() !== me.toLowerCase())); }, [me]);

  useEffect(() => {
    const n = ++seq.current;
    const t = text.trim();
    if (!t || t === "@") { setRes({ state: "idle" }); return; }
    setRes({ state: "looking" });
    const h = setTimeout(() => {
      void lookup(t, { me, allowAddress }).then((r) => {
        if (n !== seq.current) return;
        setRes(r);
        if (r.state === "found") onChange(r.r);
      });
    }, 280);
    return () => clearTimeout(h);
    // onChange is the caller's setter; re-running on it would re-look up every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, me, allowAddress]);

  if (value) return (
    <div>
      <span className="r2-lbl">{label}</span>
      <RecipientCard r={value} onClear={() => { onChange(null); setText(""); setRes({ state: "idle" }); }} />
    </div>
  );

  const err = res.state === "none" ? PICKER_COPY.none(res.username)
    : res.state === "self" ? PICKER_COPY.self
    : res.state === "bad" ? (allowAddress ? PICKER_COPY.bad : PICKER_COPY.badUser) : null;
  return (
    <div>
      <label className="r2-lbl" htmlFor={id}>{label}</label>
      <div className="cx-inrow">
        <div className={`r2-field up-field${err ? " bad" : ""}`}>
          {!/^0x/i.test(text) && <span className="up-at" aria-hidden>@</span>}
          <input id={id} placeholder={allowAddress ? PICKER_COPY.phAddr : PICKER_COPY.ph} value={text.replace(/^@/, "")} autoComplete="off" autoCapitalize="none" spellCheck={false}
            data-testid="picker-input" onChange={(e) => setText(e.target.value.trim())} />
          {res.state === "looking" && <i className="up-pulse" aria-label="Looking up" />}
        </div>
        <button type="button" className="r2-btn cx-copy" onClick={async () => { try { const t = await navigator.clipboard.readText(); if (t) setText(t.trim()); } catch { /* no clipboard read */ } }}>{PICKER_COPY.paste}</button>
      </div>
      {err && <span className="up-err" role="alert" data-testid="picker-err">{err}</span>}
      {!text && recent.length > 0 && (
        <div className="up-recent" role="group" aria-label={PICKER_COPY.recent}>
          {recent.map((r) => (
            <button key={r.address} type="button" onClick={() => onChange(r)} data-testid="picker-recent">
              <Avatar r={r} size={22} /><span>{recipientLabel(r)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
