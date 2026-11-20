"use client";
/**
 * /admin/stats — Team-only numbers: sign-ups, launches, trading, funnel and Turbo (lib/server/adminStats).
 * Same login gate as /admin/invites: Privy session whose email is in ADMIN_EMAILS, checked server side.
 */
import { useCallback, useEffect, useState } from "react";
import { onPrivy } from "@/lib/aa/session";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { withBase } from "@/lib/base-path";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { loginPrivy, NeedLogin } from "@/lib/invitesClient";
import type { AdminStats as Data } from "@/lib/server/adminStats";

const nf = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const explorer = ACTIVE_CHAIN.blockExplorers?.default.url?.replace(/\/$/, "") ?? "";
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const STEP: Record<string, string> = {
  land: "Visited", signin: "Signed in", fund: "Added cash", first_trade: "First trade", first_launch: "First launch", return_d1: "Came back next day",
  duel_start: "Duel started", duel_finish: "Duel finished", duel_share: "Duel shared", duel_join: "Joined a duel link", duel_rematch: "Rematch",
  duel_request: "Rematch request", royale_join: "Royale round",
};

async function load(fresh: boolean): Promise<Data> {
  const t = await privyAccessToken();
  if (!t) throw new NeedLogin("Sign in first.");
  const r = await fetch(withBase(`/api/admin/stats${fresh ? "?fresh=1" : ""}`), { headers: { authorization: `Bearer ${t}` }, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error || "Something went wrong."), { status: r.status });
  return j as Data;
}

function Who({ w, names }: { w: string; names: Record<string, string> }) {
  const n = names[w.toLowerCase()];
  const label = n ? `@${n}` : short(w);
  return explorer ? <a href={`${explorer}/address/${w}`} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>;
}

function Tile({ label, value, today, d7 }: { label: string; value: string; today?: string; d7?: string }) {
  return (
    <div className="as-tile">
      <span className="cl-eyebrow">{label}</span>
      <strong>{value}</strong>
      {(today || d7) && <span className="as-sub">{today && <b>{today} today</b>}{d7 && <span>{d7} 7d</span>}</span>}
    </div>
  );
}

export default function AdminStats({ configured = false }: { configured?: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [gate, setGate] = useState<"login" | "denied" | "off" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = useCallback(async (fresh = false) => {
    if (!configured) { setGate("off"); return; }
    setErr(null); setBusy(true);
    try { setData(await load(fresh)); setGate(null); }
    catch (e) {
      const s = (e as { status?: number }).status;
      if (e instanceof NeedLogin || s === 401) setGate("login");
      else if (s === 403) setGate("denied");
      else if (s === 503 && !data) setGate("off");
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  }, [configured, data]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void go(); if (configured) return onPrivy(() => void go()); }, [configured]);

  const d = data;
  const t = d?.trades, l = d?.launches, u = d?.users;
  const days = (u?.byDay ?? l?.byDay ?? t?.byDay ?? []).map((x) => x.day).slice().reverse();
  const at = (rows: { day: string }[] | undefined, day: string) => rows?.find((r) => r.day === day) as Record<string, number> | undefined;

  return (
    <div className="cl-page as-page" data-testid="admin-stats">
      <header className="cl-head">
        <div><div className="cl-eyebrow">Team</div><h1 className="cl-display">Stats</h1></div>
        {d && <div className="as-head-r"><span className="muted">{new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          <button type="button" className="cl-btn sm" disabled={busy} onClick={() => void go(true)}>{busy ? "…" : "Refresh"}</button></div>}
      </header>

      {gate === "login" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Log in</h3><button type="button" className="cl-btn primary" onClick={loginPrivy}>Log in</button></section>}
      {gate === "denied" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Team only</h3></section>}
      {gate === "off" && <section className="cl-card cl-empty" data-testid="admin-off"><h3 className="cl-display sm">No Team emails set</h3><p className="muted">Set ADMIN_EMAILS on the server.</p></section>}
      {err && <p className="cl-err" role="alert">{err}</p>}
      {!gate && !d && busy && <div className="as-pulse" aria-label="Loading" />}

      {!gate && d && (
        <div className="as-stack">
          <section className="as-tiles">
            <Tile label="Users" value={nf(u?.total)} today={u ? `+${nf(u.today)}` : undefined} d7={u ? `+${nf(u.d7)}` : undefined} />
            <Tile label="Usernames" value={nf(d.usernames)} />
            <Tile label="Launches" value={nf(l?.total)} today={l ? `+${nf(l.today)}` : undefined} d7={l ? `+${nf(l.d7)}` : undefined} />
            <Tile label="Traders" value={nf(t?.total.traders)} today={t ? nf(t.today.traders) : undefined} d7={t ? nf(t.d7.traders) : undefined} />
            <Tile label="Volume" value={usd(t?.total.volume)} today={t ? usd(t.today.volume) : undefined} d7={t ? usd(t.d7.volume) : undefined} />
            <Tile label="Trades" value={nf(t?.total.trades)} today={t ? nf(t.today.trades) : undefined} d7={t ? nf(t.d7.trades) : undefined} />
          </section>
          {(d.usersError || d.launchesError) && <p className="cl-err">{d.usersError ? `Users: ${d.usersError}. ` : ""}{d.launchesError ? `Launches: ${d.launchesError}` : ""}</p>}

          <section className="cl-card as-card">
            <h3 className="cl-display xs">By day <span className="muted as-note">UTC</span></h3>
            <div className="as-scroll"><table className="as-table">
              <thead><tr><th>Day</th><th>Sign-ups</th><th>Launches</th><th>Trades</th><th>Volume</th><th>Traders</th><th>New traders</th></tr></thead>
              <tbody>{days.map((day) => { const a = at(u?.byDay, day), b = at(l?.byDay, day), c = at(t?.byDay, day); return (
                <tr key={day}><td>{dayLabel(day)}</td><td>{nf(a?.signups)}</td><td>{nf(b?.launches)}</td><td>{nf(c?.trades)}</td><td>{usd(c?.volume)}</td><td>{nf(c?.traders)}</td><td>{nf(c?.newTraders)}</td></tr>); })}</tbody>
            </table></div>
          </section>

          <div className="as-two">
            <section className="cl-card as-card">
              <h3 className="cl-display xs">Top traders</h3>
              <table className="as-table"><thead><tr><th>#</th><th>Pilot</th><th>Volume</th><th>Trades</th><th>Coins</th></tr></thead>
                <tbody>{(t?.top ?? []).map((r, i) => <tr key={r.wallet}><td>{i + 1}</td><td><Who w={r.wallet} names={d.names} /></td><td>{usd(r.volume)}</td><td>{nf(r.trades)}</td><td>{nf(r.coins)}</td></tr>)}</tbody></table>
              {!t?.top.length && <p className="muted">No trades yet</p>}
            </section>
            <section className="cl-card as-card">
              <h3 className="cl-display xs">Top launchers {l && l.anon > 0 && <span className="muted as-note">+{nf(l.anon)} anon</span>}</h3>
              <table className="as-table"><thead><tr><th>#</th><th>Pilot</th><th>Launches</th></tr></thead>
                <tbody>{(l?.top ?? []).map((r, i) => <tr key={r.wallet}><td>{i + 1}</td><td><Who w={r.wallet} names={d.names} /></td><td>{nf(r.launches)}</td></tr>)}</tbody></table>
              {!l?.top.length && <p className="muted">No launches yet</p>}
            </section>
          </div>

          <div className="as-two">
            <section className="cl-card as-card">
              <h3 className="cl-display xs">Newest launches</h3>
              <table className="as-table"><thead><tr><th>Coin</th><th>By</th><th>Mcap</th><th>When</th></tr></thead>
                <tbody>{(l?.recent ?? []).map((c) => <tr key={c.token}><td><a href={withBase(`/coin/${c.token}`)}>${c.ticker}</a>{c.graduated && <span className="as-chip">Grad</span>}</td>
                  <td>{c.anon ? <span className="muted">Anon</span> : <Who w={c.creator} names={d.names} />}</td><td>{usd(c.mcapUsd)}</td>
                  <td className="muted">{c.ts ? new Date(c.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td></tr>)}</tbody></table>
            </section>
            <section className="cl-card as-card">
              <h3 className="cl-display xs">Top coins</h3>
              <table className="as-table"><thead><tr><th>Coin</th><th>Volume</th><th>Trades</th></tr></thead>
                <tbody>{(t?.topCoins ?? []).map((c) => <tr key={c.coin}><td><a href={withBase(`/coin/${c.coin}`)}>${d.coinNames[c.coin] ?? short(c.coin)}</a></td><td>{usd(c.volume)}</td><td>{nf(c.trades)}</td></tr>)}</tbody></table>
            </section>
          </div>

          <div className="as-two">
            <section className="cl-card as-card">
              <h3 className="cl-display xs">Funnel <span className="muted as-note">once per browser</span></h3>
              <table className="as-table"><thead><tr><th>Step</th><th>Today</th><th>7d</th><th>All</th></tr></thead>
                <tbody>{(d.funnel ?? []).map((r) => <tr key={r.step}><td>{STEP[r.step] ?? r.step}</td><td>{nf(r.today)}</td><td>{nf(r.d7)}</td><td>{nf(r.total)}</td></tr>)}</tbody></table>
            </section>
            <div className="as-stack">
              <section className="cl-card as-card">
                <h3 className="cl-display xs">Turbo</h3>
                <table className="as-table"><tbody>
                  <tr><td>Duel rooms</td><td>{nf(d.duels?.today)} today</td><td>{nf(d.duels?.d7)} 7d</td><td>{nf(d.duels?.total)} all</td></tr>
                  <tr><td>Lighter fee acct {d.lighter?.account ? `#${d.lighter.account}` : ""}</td><td colSpan={3}>{d.lighter?.enabled ? usd(d.lighter.collateral) : <span className="muted">Lighter off</span>}{d.lighterError && <span className="muted"> ({d.lighterError})</span>}</td></tr>
                </tbody></table>
              </section>
              <section className="cl-card as-card">
                <h3 className="cl-display xs">Sign-in methods</h3>
                <div className="as-chips">{Object.entries(u?.logins ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k} className="as-chip lg">{k} <b>{nf(v)}</b></span>)}</div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
