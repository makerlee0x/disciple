"use client";
/**
 * Username in Edit profile (lee, Nov 11: "the username should be in the edit profile not in the settings"). Same claim /
 * 24h cooldown flow as before (lib/profile claimUsername, server-enforced nextAllowedAt). `useUsernameDraft` holds the
 * draft + availability check; Edit profile's one Save claims it (UsernameField is the input row).
 */
import { useEffect, useState } from "react";
import { checkUsername, claimUsername, fetchUsernameStatus, localUsername, normalizeUsername, USERNAME_MAX, validateUsername } from "@/lib/profile";
import { formatLocalWhen } from "@/lib/usernameCooldown";
import { PROFILE_COPY as C } from "@/lib/copy/profile";

export type UsernameStatus = { ok: boolean; text: string; bad?: boolean } | null;
export type UsernameDraft = {
  me: string; name: string; setName: (v: string) => void; changed: boolean; status: UsernameStatus; locked: boolean; nextAt: number | null;
  /** Claim the typed name. ok:false carries a plain reason (and moves the cooldown when the server says so). */
  claim: () => Promise<{ ok: boolean; reason?: string }>;
};

export function useUsernameDraft(wallet: string | null, open = true): UsernameDraft {
  const [me, setMe] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<UsernameStatus>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  useEffect(() => { if (!open) return; const u = localUsername(); setMe(u); setName(u); }, [open]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchUsernameStatus(wallet).then((s) => {
      if (!alive) return;
      setNextAt(s.nextAllowedAt);
      if (s.username && !localUsername()) { setMe(s.username); setName(s.username); }
    });
    return () => { alive = false; };
  }, [wallet, open]);
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

  async function claim() {
    const r = await claimUsername(name, wallet);
    if (!r.ok) { if (r.nextAllowedAt) { setNextAt(r.nextAllowedAt); setName(me); } return { ok: false, reason: r.reason || C["edit.error.save"] }; }
    setMe(normalizeUsername(name)); setStatus(null);
    return { ok: true };
  }
  return { me, name, setName: (v) => setName(v.toLowerCase()), changed, status, locked, nextAt, claim };
}

/** The Username field inside Edit profile (no Save of its own: the sheet's one Save claims it). */
export function UsernameField({ u, disabled }: { u: UsernameDraft; disabled?: boolean }) {
  return (
    <label className="p5-fld" data-testid="edit-username">
      <span className="lab">Username</span>
      <span className="p5-inp p5-inp-name"><span className="pre">@</span>
        <input value={u.name} maxLength={USERNAME_MAX} placeholder="your_name" autoComplete="off" spellCheck={false} disabled={u.locked || disabled}
          aria-label="Username" onChange={(e) => u.setName(e.target.value)} />
      </span>
      <span className="p5-help-row">
        {u.status ? <span className={`p5-fine ${u.status.ok ? "ok" : u.status.bad ? "bad" : ""}`} role="status" data-testid="username-status">{u.status.text}</span>
          : <span className="p5-fine" data-testid="username-cooldown">{u.locked ? C["username.cooldown.note"](formatLocalWhen(u.nextAt!)) : "Once every 24 hours."}</span>}
      </span>
    </label>
  );
}
