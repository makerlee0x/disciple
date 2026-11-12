"use client";
/**
 * Settings → Username (profile r3: the username moved here from Edit profile). Same claim / 24h cooldown flow as before
 * (lib/profile claimUsername, server-enforced nextAllowedAt). Type a new name; Save shows once it is available.
 */
import { useEffect, useState } from "react";
import { checkUsername, claimUsername, fetchUsernameStatus, localUsername, normalizeUsername, USERNAME_MAX, validateUsername } from "@/lib/profile";
import { formatLocalWhen } from "@/lib/usernameCooldown";
import { PROFILE_COPY as C } from "@/lib/copy/profile";

export default function UsernameRow({ wallet }: { wallet: string | null }) {
  const [me, setMe] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string; bad?: boolean } | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { const u = localUsername(); setMe(u); setName(u); }, []);
  useEffect(() => {
    let alive = true;
    void fetchUsernameStatus(wallet).then((s) => {
      if (!alive) return;
      setNextAt(s.nextAllowedAt);
      if (s.username && !localUsername()) { setMe(s.username); setName(s.username); }
    });
    return () => { alive = false; };
  }, [wallet]);
  const locked = nextAt != null && nextAt > Date.now();
  const changed = !!name && normalizeUsername(name) !== me;
  useEffect(() => {
    if (!changed) { setStatus(null); return; }
    const bad = validateUsername(name);
    if (bad) { setStatus({ ok: false, text: bad, bad: true }); return; }
    setStatus({ ok: false, text: C["edit.username.checking"] });
    let alive = true;
    const t = setTimeout(async () => {
      const r = await checkUsername(name);
      if (alive) setStatus({ ok: r.available, text: r.available ? `Available${r.reason ? ` (${r.reason})` : ""}` : r.reason || "Taken", bad: !r.available });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [name, changed]);

  async function save() {
    setBusy(true); setErr("");
    const r = await claimUsername(name, wallet);
    setBusy(false);
    if (!r.ok) { if (r.nextAllowedAt) { setNextAt(r.nextAllowedAt); setName(me); } setErr(r.reason || C["edit.error.save"]); return; }
    setMe(normalizeUsername(name)); setStatus(null);
  }

  return (
    <div className="p5-srow p5-srow-name" data-testid="settings-username">
      <div className="tx">
        <b>Username</b>
        <span data-testid="username-cooldown">{locked ? C["username.cooldown.note"](formatLocalWhen(nextAt!)) : "Once every 24 hours."}</span>
        {status && <span className={status.ok ? "ok" : status.bad ? "bad" : ""} role="status" data-testid="username-status">{status.text}</span>}
        {err && <span className="bad" role="alert">{err}</span>}
      </div>
      <form className="p5-name-edit" onSubmit={(e) => { e.preventDefault(); if (changed && status?.ok && !busy) void save(); }}>
        <span className="p5-inp sm"><span className="pre">@</span>
          <input value={name} maxLength={USERNAME_MAX} placeholder="your_name" autoComplete="off" spellCheck={false} disabled={locked || busy}
            aria-label="Username" onChange={(e) => setName(e.target.value.toLowerCase())} />
        </span>
        {changed && <button type="submit" className="p5-btn sm primary" disabled={!status?.ok || busy}>{busy ? C["edit.saving"] : "Save"}</button>}
      </form>
    </div>
  );
}
