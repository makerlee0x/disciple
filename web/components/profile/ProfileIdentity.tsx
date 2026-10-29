"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/wallet";
import type { Address } from "@/lib/protocol";
import {
  checkUsername, claimUsername, fetchUsernameStatus, localUsername, localXHandle, normalizeUsername,
  profileUrl, referralUrl, setLocalXHandle, validateUsername,
} from "@/lib/profile";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";
import { refLabel } from "@/lib/referral";
import { formatLocalWhen } from "@/lib/usernameCooldown";
import { PROFILE_COPY as C } from "@/lib/copy/profile";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Private-profile identity strip: unique username (referral handle), X connect, wallet address.
 * `hideUsername`: the Settings modal on /profile, where the username is edited in Edit profile instead; the username
 * shows read-only here with the 24h change rule / when the next change is allowed (server's nextAllowedAt, local time).
 */
export default function ProfileIdentity({ hideUsername = false }: { hideUsername?: boolean } = {}) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [username, setUsername] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [x, setX] = useState("");
  const [xDraft, setXDraft] = useState("");
  const [xOpen, setXOpen] = useState(false);
  const [copied, setCopied] = useState("");

  useEffect(() => onWallet(setAddr), []);
  useEffect(() => { setUsername(localUsername()); setX(localXHandle()); }, []);
  // 24h username cooldown (server-enforced): when the next change is allowed, in the viewer's local time.
  const [nextNameAt, setNextNameAt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchUsernameStatus(addr).then((s) => {
      if (!alive) return;
      setNextNameAt(s.nextAllowedAt);
      if (s.username && !localUsername()) setUsername(s.username);
    });
    return () => { alive = false; };
  }, [addr]);
  const nameLocked = nextNameAt != null && nextNameAt > Date.now();
  const cooldownNote = (
    <span className="muted tiny pid-cooldown" data-testid="username-cooldown">
      {nameLocked ? C["username.cooldown.note"](formatLocalWhen(nextNameAt!)) : C["username.cooldown.rule"]}
    </span>
  );

  // Debounced availability check while editing.
  useEffect(() => {
    if (!editing || !draft) { setStatus(null); return; }
    const bad = validateUsername(draft);
    if (bad) { setStatus({ ok: false, text: bad }); return; }
    if (normalizeUsername(draft) === username) { setStatus({ ok: true, text: "That's you." }); return; }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await checkUsername(draft);
      if (alive) setStatus({ ok: r.available, text: r.available ? `Available${r.reason ? ` (${r.reason})` : ""}` : r.reason || "Taken" });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [draft, editing, username]);

  async function save() {
    const r = await claimUsername(draft, addr);
    if (!r.ok && r.nextAllowedAt) { setNextNameAt(r.nextAllowedAt); setEditing(false); }
    if (!r.ok) { setStatus({ ok: false, text: r.reason || "Could not save." }); return; }
    setUsername(normalizeUsername(draft)); setEditing(false); setStatus(null);
  }
  const copy = (k: string, v: string) => { navigator.clipboard?.writeText(v); setCopied(k); setTimeout(() => setCopied(""), 1200); };

  return (
    <section className="chart-card profile-identity" aria-label="Identity">
      <div className="pid-row">
        {!hideUsername && <div className="pid-block">
          <span className="pid-label">USERNAME</span>
          {editing ? (
            <div className="pid-edit">
              <span className="muted">@</span>
              <input className="ds-input" autoFocus value={draft} maxLength={20} placeholder="your_name"
                onChange={(e) => setDraft(e.target.value.toLowerCase())}
                onKeyDown={(e) => { if (e.key === "Enter" && status?.ok) void save(); if (e.key === "Escape") setEditing(false); }} />
              <button type="button" className="ds-btn gold" disabled={!status?.ok} onClick={save}>Save</button>
              <button type="button" className="ds-btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          ) : (
            <div className="pid-value">
              {username ? <Link href={profileUrl(username)} title="Open public profile">@{username}</Link> : <span className="muted">Not set</span>}
              <button type="button" className="ds-btn" disabled={nameLocked} onClick={() => { setDraft(username); setEditing(true); }}>{username ? "Edit" : "Choose username"}</button>
            </div>
          )}
          {cooldownNote}
          {status && <span className={`pid-status ${status.ok ? "ok" : "bad"}`} role="status">{status.text}</span>}
        </div>}

        {hideUsername && <div className="pid-block">
          <span className="pid-label">USERNAME</span>
          <div className="pid-value">
            {username ? <Link href={profileUrl(username)} title="Open public profile">@{username}</Link> : <span className="muted">Not set</span>}
          </div>
          {cooldownNote}
        </div>}

        <div className="pid-block">
          <span className="pid-label">WALLET</span>
          <div className="pid-value mono">
            {addr ? <>
              <span title={addr}>{short(addr)}</span>
              <button type="button" className="ds-btn" onClick={() => copy("addr", addr)}>{copied === "addr" ? "Copied" : "Copy"}</button>
            </> : <span className="muted">Sign in to see this.</span>}
          </div>
        </div>

        <div className="pid-block">
          <span className="pid-label">X / TWITTER <span className="beta">BETA</span></span>
          {x ? (
            <div className="pid-value">
              <a href={`https://x.com/${x}`} target="_blank" rel="noreferrer">@{x}</a>
              <span className="pid-status ok">connected (self-reported)</span>
              <button type="button" className="ds-btn" onClick={() => { setLocalXHandle(""); setX(""); }}>Disconnect</button>
            </div>
          ) : xOpen ? (
            <div className="pid-edit">
              <span className="muted">@</span>
              <input className="ds-input" value={xDraft} maxLength={15} placeholder="handle" onChange={(e) => setXDraft(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} />
              <button type="button" className="ds-btn gold" disabled={xDraft.length < 1} onClick={() => { setLocalXHandle(xDraft); setX(xDraft); setXOpen(false); }}>Confirm</button>
            </div>
          ) : (
            <div className="pid-value">
              <button type="button" className="ds-btn x" onClick={() => setXOpen(true)}>𝕏 Connect X</button>
            </div>
          )}
          {!x && xOpen && <span className="muted tiny">Linking accounts is coming soon.</span>}
        </div>

        <div className="pid-block">
          <span className="pid-label">REFERRAL LINK</span>
          <div className="pid-value">
            {username || addr ? <>
              <span className="mono tiny">{refLabel(username || null, addr, typeof window !== "undefined" ? window.location.host : undefined)}</span>
              <button type="button" className="ds-btn" onClick={() => copy("ref", referralUrl(username || null, addr))}>{copied === "ref" ? "Copied" : "Copy link"}</button>
              {!username && <span className="muted tiny">Set a username for a shorter link</span>}
            </> : <span className="muted">Sign in to get one</span>}
          </div>
        </div>
      </div>
      {IS_STATIC_PREVIEW && <p className="muted tiny">Static preview: usernames are saved in this browser only (no uniqueness check).</p>}
    </section>
  );
}
