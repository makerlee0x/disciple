"use client";
/**
 * /admin/catalog — the live catalogue (lib/collection Catalog, lib/server/catalog). Set dates for each series and drop,
 * add a drop, upload art, or edit the whole overlay as JSON. Saves go live within 30 seconds, with no deploy. The
 * server refuses any save that changes or pulls back an item that already has copies. Same login as /admin/invites.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { onPrivy } from "@/lib/aa/session";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { withBase } from "@/lib/base-path";
import { loginPrivy } from "@/lib/invitesClient";
import { PAINTS, RARITY_COLOR, type Catalog, type Drop, type Rarity, type Series } from "@/lib/collection";

type Row = { id: string; kind: string; name: string; rar: Rarity; series: number; drop: string | null; out: boolean; supply: number; base: boolean };
type Data = { me: string; catalog: Catalog | null; now: number; series: Series[]; drops: Drop[]; items: Row[]; log: { v: number; at: number; by: string }[]; blob: boolean };
type Err = Error & { status?: number; problems?: string[] };

async function call<T>(init?: RequestInit): Promise<T> {
  const t = await privyAccessToken();
  if (!t) throw Object.assign(new Error("Log in first."), { status: 401 });
  const r = await fetch(withBase("/api/admin/catalog"), { ...init, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; problems?: string[] };
  if (!r.ok) throw Object.assign(new Error(j.error || "Something went wrong. Try again."), { status: r.status, problems: j.problems }) as Err;
  return j;
}
/** ms ⇄ the admin's local "YYYY-MM-DDTHH:mm" */
const toLocal = (ms: number | null) => { if (ms == null || ms <= 0) return ""; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = (s: string) => (s ? new Date(s).getTime() : null);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
const when = (t: number) => new Date(t).toLocaleString();

export default function AdminCatalog({ configured = false }: { configured?: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [gate, setGate] = useState<"login" | "denied" | "off" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [json, setJson] = useState("");
  const [grantTo, setGrantTo] = useState("maker");
  /** tradable test copies for listing (maker 2026-11-18): a spread of rarities per kind, via /api/admin/market op grant */
  const grantTest = async () => {
    if (!data) return;
    const order: Rarity[] = ["mythic", "legendary", "epic", "rare", "uncommon", "common"];
    const pick = (kind: string, n: number) => {
      const rows = data.items.filter((r) => r.kind === kind && !r.id.startsWith("tag-prestige") && r.out);
      const out: string[] = [];
      for (const rar of [...order].reverse()) { const r = rows.find((x) => x.rar === rar && !out.includes(x.id)); if (r) out.push(r.id); if (out.length >= n) break; }
      return out;
    };
    const items = [...pick("skin", 4), ...pick("trail", 4), ...pick("tag", 3)];
    setBusy(true); setErr(null); setMsg(null);
    try {
      const t = await privyAccessToken();
      if (!t) throw new Error("Log in first.");
      const r = await fetch(withBase("/api/admin/market"), { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ op: "grant", username: grantTo.trim(), items }), cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { copies?: { item: string }[]; skipped?: string[]; reason?: string };
      if (!r.ok) throw new Error(j.reason || "Grant failed.");
      setMsg(`Granted ${j.copies?.length ?? 0} items to @${grantTo.trim()}${j.skipped?.length ? ` (skipped ${j.skipped.join(", ")})` : ""}.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const [nd, setNd] = useState({ name: "", series: "1", start: "", paints: [] as string[] });
  const [up, setUp] = useState({ name: "", url: "" });

  const load = useCallback(async () => {
    if (!configured) { setGate("off"); return; }
    try {
      const d = await call<Data>(); setData(d); setGate(null);
      setJson(JSON.stringify(d.catalog ?? { v: 0 }, null, 2));
      const ds: Record<string, string> = {};
      d.series.forEach((s) => { ds[`s${s.n}:start`] = s.start === 0 ? "launch" : toLocal(s.start); ds[`s${s.n}:end`] = toLocal(s.end); });
      d.drops.forEach((x) => { ds[`d:${x.id}`] = toLocal(x.start); });
      setDates(ds);
    } catch (e) {
      const s = (e as Err).status; setData(null);
      if (s === 401) setGate("login"); else if (s === 403) setGate("denied"); else if (s === 503) setGate("off"); else setErr((e as Error).message);
    }
  }, [configured]);
  useEffect(() => { void load(); if (configured) return onPrivy(() => void load()); }, [load, configured]);

  const save = async (next: Catalog, done: string) => {
    if (!data) return;
    setBusy(true); setErr(null); setMsg(null); setProblems([]);
    try { await call({ method: "POST", body: JSON.stringify({ op: "save", base: data.catalog?.v ?? 0, catalog: next }) }); setMsg(`${done} Live within 30 seconds.`); await load(); }
    catch (e) { setErr((e as Error).message); setProblems((e as Err).problems ?? []); } finally { setBusy(false); }
  };
  const base = (): Catalog => JSON.parse(JSON.stringify(data?.catalog ?? { v: 0 })) as Catalog;

  // the schedule form writes every series' and drop's dates into the overlay, keeping everything else in it
  const saveDates = () => {
    if (!data) return;
    const c = base();
    c.series = data.series.map((s) => {
      const prev = c.series?.find((x) => x.n === s.n) ?? { n: s.n };
      const st = dates[`s${s.n}:start`];
      return { ...prev, start: st === "launch" ? 0 : fromLocal(st), end: fromLocal(dates[`s${s.n}:end`]) };
    });
    c.drops = data.drops.map((d) => ({ ...(c.drops?.find((x) => x.id === d.id) ?? { id: d.id, series: d.series, name: d.name }), start: fromLocal(dates[`d:${d.id}`]) }));
    void save(c, "Dates saved.");
  };
  const addDrop = () => {
    if (!data || !nd.name.trim()) return;
    const c = base(), id = `s${nd.series}-${slug(nd.name)}`;
    c.drops = [...(c.drops ?? []).filter((d) => d.id !== id), { id, series: Number(nd.series), name: nd.name.trim(), start: fromLocal(nd.start), paints: nd.paints }];
    void save(c, `${nd.name} added.`);
  };
  const upload = async (f: File | undefined) => {
    if (!f || !up.name) { setErr("Name the art first (the item id, e.g. needle--koi), then pick the file."); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const b64 = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(r.error); r.readAsDataURL(f); });
      const r = await call<{ url: string }>({ method: "POST", body: JSON.stringify({ op: "upload", name: up.name, type: f.type, data: b64 }) });
      setUp((u) => ({ ...u, url: r.url })); setMsg("Uploaded. Add the URL under art in the catalogue below.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const seriesPaints = useMemo(() => new Set((data?.series.find((s) => String(s.n) === nd.series)?.paints ?? []).concat(...(data?.drops.filter((d) => String(d.series) === nd.series).map((d) => d.paints ?? []) ?? []))), [data, nd.series]);
  const counts = (pred: (r: Row) => boolean) => data?.items.filter((r) => r.kind === "skin" && pred(r)).length ?? 0;

  return (
    <div className="cl-page cl-form" data-testid="admin-catalog">
      <header className="cl-head"><div>
        <div className="cl-eyebrow">Admin</div><h1 className="cl-display">Catalogue</h1>
        <p className="muted">{data ? `Signed in as ${data.me} · version ${data.catalog?.v ?? 0}` : "Series and drop dates, new items and art. Saves go live with no deploy."}</p>
      </div></header>

      {gate === "login" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Log in to edit the catalogue</h3><button type="button" className="cl-btn primary" onClick={loginPrivy}>Log in</button></section>}
      {gate === "denied" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Not an admin</h3><p className="muted">This login isn&apos;t on the admin list.</p></section>}
      {gate === "off" && <section className="cl-card cl-empty"><h3 className="cl-display sm">No admins configured</h3><p className="muted">Set ADMIN_EMAILS on the server to enable this page.</p></section>}
      {err && <div className="cl-err" role="alert">{err}{problems.length > 1 && <ul>{problems.slice(1, 12).map((p) => <li key={p}>{p}</li>)}</ul>}</div>}
      {msg && <p className="cl-ok" role="status">{msg}</p>}

      {!gate && data && (
        <div style={{ display: "grid", gap: 16 }}>
          <section className="cl-card" style={{ padding: 22 }} data-testid="cat-schedule">
            <h3 className="cl-display xs">Schedule</h3>
            <p className="muted">A series drops from its start until its end (empty = no date yet / open-ended). Only one series drops at a time; give the next one a start and end the one before. A drop adds its paints and trails to its series on its date.</p>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {data.series.map((s) => (
                <div key={s.n} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <b style={{ minWidth: 190 }}>Series {s.n} · {s.name}</b>
                  <span className="muted" style={{ minWidth: 150 }}>{s.hulls.join(", ")} · {counts((r) => r.series === s.n)} skins</span>
                  <label>Start {dates[`s${s.n}:start`] === "launch" ? <b>launch</b> : <input type="datetime-local" value={dates[`s${s.n}:start`] ?? ""} onChange={(e) => setDates({ ...dates, [`s${s.n}:start`]: e.target.value })} />}</label>
                  <label>End <input type="datetime-local" value={dates[`s${s.n}:end`] ?? ""} onChange={(e) => setDates({ ...dates, [`s${s.n}:end`]: e.target.value })} /></label>
                </div>
              ))}
              {data.drops.map((d) => (
                <div key={d.id} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <b style={{ minWidth: 190 }}>Drop · {d.name}</b>
                  <span className="muted" style={{ minWidth: 150 }}>Series {d.series} · {(d.paints ?? []).length} paints, {(d.trails ?? []).length} trails</span>
                  <label>Start <input type="datetime-local" value={dates[`d:${d.id}`] ?? ""} onChange={(e) => setDates({ ...dates, [`d:${d.id}`]: e.target.value })} /></label>
                </div>
              ))}
            </div>
            <button type="button" className="cl-btn sm primary" style={{ marginTop: 12 }} disabled={busy} onClick={saveDates}>Save dates</button>
          </section>

          <section className="cl-card" style={{ padding: 22 }} data-testid="cat-test-grant">
            <h3 className="cl-display xs">Test items</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
              <label>@<input value={grantTo} onChange={(e) => setGrantTo(e.target.value)} style={{ width: 140 }} /></label>
              <button type="button" className="cl-btn sm primary" disabled={busy || !grantTo.trim()} onClick={grantTest}>Grant 4 skins · 4 trails · 3 tags</button>
            </div>
          </section>

          <section className="cl-card" style={{ padding: 22 }} data-testid="cat-add-drop">
            <h3 className="cl-display xs">Add a drop</h3>
            <p className="muted">Pick paints for that series&apos; hulls. A new paint needs its art for each hull first (upload below, then add it under paints and art in the JSON).</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <input aria-label="Drop name" placeholder="Name, e.g. Afterburn" value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} style={{ padding: "8px 10px" }} />
              <select aria-label="Series" value={nd.series} onChange={(e) => setNd({ ...nd, series: e.target.value, paints: [] })}>{data.series.map((s) => <option key={s.n} value={s.n}>Series {s.n}</option>)}</select>
              <input type="datetime-local" aria-label="Start" value={nd.start} onChange={(e) => setNd({ ...nd, start: e.target.value })} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {Object.entries(PAINTS).filter(([k]) => !seriesPaints.has(k)).map(([k, p]) => (
                <label key={k} className="cl-btn sm ghost" style={{ borderColor: RARITY_COLOR[p.rar] }}>
                  <input type="checkbox" checked={nd.paints.includes(k)} onChange={(e) => setNd({ ...nd, paints: e.target.checked ? [...nd.paints, k] : nd.paints.filter((x) => x !== k) })} /> {p.name}
                </label>
              ))}
            </div>
            <button type="button" className="cl-btn sm primary" style={{ marginTop: 12 }} disabled={busy || !nd.name.trim()} onClick={addDrop}>Add drop</button>
          </section>

          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Upload art</h3>
            {!data.blob ? <p className="muted">Turn on a Vercel Blob store for this project to upload here. Until then, any https .webp or .png URL works in the art list.</p> : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                <input aria-label="Art name" placeholder="needle--koi, trail-frost, trail-frost:bits, series-3" value={up.name} onChange={(e) => setUp({ ...up, name: e.target.value })} style={{ padding: "8px 10px", minWidth: 280 }} />
                <input type="file" accept="image/webp,image/png" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
              </div>
            )}
            {up.url && <p className="cl-mono" style={{ wordBreak: "break-all" }}>{up.url} <button type="button" className="cl-btn sm ghost" onClick={() => void navigator.clipboard.writeText(up.url).catch(() => undefined)}>Copy</button></p>}
          </section>

          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Catalogue (JSON)</h3>
            <p className="muted">Everything the catalogue adds: series, drops, paints, hulls (with shape), trails, flourishes and art URLs. It only adds to the code list. Anything that has copies can&apos;t be renamed, re-rated, re-drawn or pulled back.</p>
            <textarea aria-label="Catalogue JSON" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} style={{ width: "100%", minHeight: 260, fontFamily: "var(--font-mono, monospace)", fontSize: 12, marginTop: 8 }} />
            <button type="button" className="cl-btn sm primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => { try { void save(JSON.parse(json) as Catalog, "Catalogue saved."); } catch { setErr("That isn't valid JSON."); } }}>Save catalogue</button>
          </section>

          <section className="cl-card" style={{ padding: 22 }} data-testid="cat-items">
            <h3 className="cl-display xs">Items ({data.items.length})</h3>
            <p className="muted">Out = can drop or show now. Frozen = copies exist, so name, rarity and art are locked for good.</p>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginTop: 8 }}>
              <thead><tr style={{ textAlign: "left" }}><th>Item</th><th>Rarity</th><th>Series</th><th>Drop</th><th>Status</th><th style={{ textAlign: "right" }}>Copies</th></tr></thead>
              <tbody>
                {data.items.filter((r) => r.series > 0 || r.kind !== "tag").map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid rgba(255,255,255,.06)" }}>
                    <td>{r.name} <span className="muted cl-mono">{r.id}</span>{!r.base && <b> · new</b>}</td>
                    <td style={{ color: RARITY_COLOR[r.rar] }}>{r.rar}</td><td>{r.series || "any"}</td><td>{r.drop ?? ""}</td>
                    <td>{r.supply > 0 ? "Frozen" : r.out ? "Out" : "Not out"}</td><td style={{ textAlign: "right" }}>{r.supply}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {!!data.log.length && (
            <section className="cl-card" style={{ padding: 22 }}>
              <h3 className="cl-display xs">Saves</h3>
              <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 4 }}>{data.log.map((l) => <li key={l.v}>v{l.v} · {when(l.at)} · {l.by}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
