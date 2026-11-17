"use client";
/**
 * /admin/mint (ADMIN_EMAILS): set up our Candy Machine for the rest of the Disciples drop. maker signs every on-chain step
 * from the collection wallet (DISCIPLE_TREASURY) in his own Solana wallet; nothing here holds a key.
 *  1. Read which drop items are already minted (Helius, server) and the names of the rest (IPFS, this browser).
 *  2. Create the machine + guards (0.777 SOL to the treasury, 7 per wallet), then its lookup table (a pNFT mint with guards
 *     is near the transaction size cap).  3. Load the items (one approval).  4. Go live: /mint starts minting from it.
 * The machine id is also kept in this browser, so a closed tab can pick up where it stopped.
 */
import { useEffect, useState } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import type { Umi } from "@metaplex-foundation/umi";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { withBase } from "@/lib/base-path";
import { short } from "@/lib/nft/client";
import { DISCIPLE_SUPPLY, DISCIPLE_TREASURY, METADATA_BASE, MINT_LIMIT, MINT_PRICE_SOL, NAME_PREFIX } from "@/lib/nft/config";
import { solConnect, type EvmWallet, type SolWallet } from "@/lib/nft/wallets";
import type { Line, MachineState } from "@/lib/nft/candy";
import WalletChooser from "./WalletChooser";

type Plan = { minted: number; used: number[]; unknown: number; candyMachine: string | null; lut: string | null };
const LS = "disciple:admin:cm", LS_LUT = "disciple:admin:lut";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };

async function adminCall<T>(init?: RequestInit): Promise<T> {
  const t = await privyAccessToken();
  if (!t) throw new Error("Sign in with your admin account first.");
  const r = await fetch(withBase("/api/admin/nft"), { ...init, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status}).`);
  return j;
}

/** Names of the remaining drop files, 12 at a time. */
async function loadLines(items: number[], onProgress: (n: number) => void): Promise<Line[]> {
  const out: Line[] = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const k = next++, item = items[k];
      let name = "";
      for (let tries = 0; tries < 3 && !name; tries++) {
        try { name = ((await (await fetch(`${METADATA_BASE}${item}.json`)).json()) as { name?: string }).name || ""; } catch { /* retry */ }
      }
      if (!name.startsWith(NAME_PREFIX)) throw new Error(`Item ${item}: unexpected name "${name}".`);
      const number = name.slice(NAME_PREFIX.length);
      if (!/^\d{1,3}$/.test(number)) throw new Error(`Item ${item}: unexpected number "${number}".`);
      out[k] = { item, number };
      onProgress(++done);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}

export default function AdminMint({ configured }: { configured: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [named, setNamed] = useState(0);
  const [w, setW] = useState<{ sw: SolWallet; acc: WalletAccount } | null>(null);
  const [umi, setUmi] = useState<Umi | null>(null);
  const [cm, setCm] = useState<string | null>(null);
  const [lut, setLut] = useState<string | null>(null);
  const [state, setState] = useState<MachineState | null>(null);
  const [rent, setRent] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l]);

  useEffect(() => { setCm(lsGet(LS)); setLut(lsGet(LS_LUT)); }, []);
  const remaining = plan ? Array.from({ length: DISCIPLE_SUPPLY }, (_, i) => i).filter((i) => !plan.used.includes(i)) : [];

  async function run(label: string, f: () => Promise<void>) {
    setBusy(label); setErr("");
    try { await f(); } catch (e) { console.warn("[disciple] admin mint", e); setErr(e instanceof Error ? e.message : String(e)); }
    setBusy("");
  }
  const readPlan = () => run("plan", async () => {
    const p = await adminCall<Plan>();
    setPlan(p); if (p.candyMachine) { setCm((c) => c ?? p.candyMachine); setLut((l) => l ?? p.lut); }
    note(`Minted ${p.minted}. ${p.unknown ? `${p.unknown} minted NFTs don't point at the drop folder. ` : ""}Left ${DISCIPLE_SUPPLY - p.used.length}.`);
  });
  const readNames = () => run("names", async () => {
    setNamed(0);
    const l = await loadLines(remaining, setNamed);
    const nums = new Set(l.map((x) => x.number));
    if (nums.size !== l.length) throw new Error("Two remaining items share a number. Stop and check the drop folder.");
    setLines(l); note(`Loaded ${l.length} names.`);
  });
  async function connect(sw: SolWallet | EvmWallet) {
    if (sw.kind !== "sol") return;
    await run("connect", async () => {
      const acc = await solConnect(sw);
      const { makeUmi } = await import("@/lib/nft/umi");
      const u = makeUmi(sw, acc);
      setW({ sw, acc }); setUmi(u);
      if (acc.address !== DISCIPLE_TREASURY) note(`Connected ${short(acc.address)}. Setup needs ${short(DISCIPLE_TREASURY)}.`);
      if (lines) { const { machineRentSol } = await import("@/lib/nft/candy"); setRent(await machineRentSol(u, lines.length)); }
    });
  }
  const readState = async (u: Umi, id: string) => {
    const { readMachine } = await import("@/lib/nft/candy");
    const s = await readMachine(u, id); setState(s); setLoaded(s.itemsLoaded); return s;
  };
  useEffect(() => { if (umi && cm) void readState(umi, cm).catch(() => setState(null)); }, [umi, cm]);
  useEffect(() => { if (umi && lines) void import("@/lib/nft/candy").then(({ machineRentSol }) => machineRentSol(umi, lines.length)).then(setRent).catch(() => {}); }, [umi, lines]);

  const createIt = () => run("create", async () => {
    if (!umi || !lines) return;
    const { createMachine } = await import("@/lib/nft/candy");
    const id = await createMachine(umi, lines.length);
    lsSet(LS, id); setCm(id); note(`Machine created: ${id}`);
    await readState(umi, id);
  });
  const lutIt = () => run("lut", async () => {
    if (!umi || !cm) return;
    const { createLut } = await import("@/lib/nft/candy");
    const id = await createLut(umi, cm);
    lsSet(LS_LUT, id); setLut(id); note(`Lookup table: ${id}`);
  });
  const loadIt = () => run("load", async () => {
    if (!umi || !lines || !cm) return;
    const s = await readState(umi, cm);
    if (s.itemsAvailable !== lines.length) throw new Error(`Machine holds ${s.itemsAvailable} items but ${lines.length} are left. Re-read and create a new machine.`);
    const { addLines } = await import("@/lib/nft/candy");
    const from = s.itemsLoaded;
    await addLines(umi, cm, from, lines.slice(from), (n) => setLoaded(from + n));
    const after = await readState(umi, cm);
    note(`Loaded ${after.itemsLoaded} / ${after.itemsAvailable}.`);
  });
  const goLive = (id: string | null) => run("live", async () => {
    const r = await adminCall<{ candyMachine: string | null; lut: string | null }>({ method: "POST", body: JSON.stringify({ candyMachine: id, lut: id ? lut : null }) });
    setPlan((p) => (p ? { ...p, candyMachine: r.candyMachine, lut: r.lut } : p));
    note(id ? `Live: /mint now mints from ${id}.` : "Mint is off.");
  });

  if (!configured) return <div className="nft-admin"><h1>Mint setup</h1><p className="p5-err">ADMIN_EMAILS isn&apos;t set.</p></div>;
  const isTreasury = w?.acc.address === DISCIPLE_TREASURY;
  const full = !!state && state.itemsLoaded >= state.itemsAvailable;
  const live = !!plan?.candyMachine && plan.candyMachine === cm;


  return (
    <div className="nft-admin" data-testid="admin-mint">
      <h1>Mint setup</h1>
      <p className="nft-warn">Pause the LaunchMyNFT mint before step 2, or the same disciples can sell twice.</p>

      <ol className="nft-steps">
        <li className={plan ? "ok" : ""}>
          <b>1. Read the drop</b>
          <div>
            <button type="button" className="p5-btn sm" disabled={!!busy} onClick={readPlan}>{busy === "plan" ? "Reading…" : plan ? "Read again" : "Read minted"}</button>
            {plan && <button type="button" className="p5-btn sm" disabled={!!busy || !remaining.length} onClick={readNames}>{busy === "names" ? `Names ${named} / ${remaining.length}` : lines ? "Reload names" : `Load ${remaining.length} names`}</button>}
          </div>
          {plan && <span className="nft-kv">Minted {plan.minted} · Left {remaining.length}{lines ? ` · Names ${lines.length}` : ""}</span>}
        </li>

        <li className={isTreasury ? "ok" : ""}>
          <b>2. Connect {short(DISCIPLE_TREASURY)}</b>
          {w ? <span className="nft-kv">{short(w.acc.address)}{isTreasury ? "" : " (wrong wallet)"}</span> : <WalletChooser chain="sol" busy={!!busy} onPick={(x) => void connect(x)} />}
        </li>

        <li className={cm ? "ok" : ""}>
          <b>3. Create machine</b>
          <span className="nft-kv">{lines ? `${lines.length} items · ${MINT_PRICE_SOL} SOL · ${MINT_LIMIT} per wallet · pNFT · 7% royalty` : "Load names first"}</span>
          {rent !== null && <span className="nft-kv">Rent locked: {rent.toFixed(4)} SOL + network fees</span>}
          {cm ? <span className="nft-kv mono">{cm}</span>
            : <button type="button" className="p5-btn sm p5-gold" disabled={!!busy || !lines || !isTreasury} onClick={createIt}>{busy === "create" ? "Creating…" : "Create"}</button>}
          {cm && <button type="button" className="p5-btn sm" disabled={!!busy} onClick={() => { lsSet(LS, null); lsSet(LS_LUT, null); setCm(null); setLut(null); setState(null); }}>Forget this machine</button>}
        </li>

        <li className={lut ? "ok" : ""}>
          <b>4. Lookup table</b>
          {lut ? <span className="nft-kv mono">{lut}</span>
            : <button type="button" className="p5-btn sm p5-gold" disabled={!!busy || !cm || !isTreasury} onClick={lutIt}>{busy === "lut" ? "Creating…" : "Create"}</button>}
        </li>

        <li className={full ? "ok" : ""}>
          <b>5. Load items</b>
          {state && <span className="nft-kv">{loaded} / {state.itemsAvailable} loaded · {state.itemsRedeemed} minted</span>}
          <button type="button" className="p5-btn sm p5-gold" disabled={!!busy || !cm || !lines || !isTreasury || full} onClick={loadIt}>{busy === "load" ? `Loading ${loaded}…` : "Load (one approval)"}</button>
        </li>

        <li className={live ? "ok" : ""}>
          <b>6. Go live</b>
          {live ? <button type="button" className="p5-btn sm" disabled={!!busy} onClick={() => goLive(null)}>Turn mint off</button>
            : <button type="button" className="p5-btn sm p5-gold" disabled={!!busy || !cm || !full || !lut} onClick={() => goLive(cm)}>Go live</button>}
        </li>
      </ol>

      {err && <p className="p5-err" role="alert">{err}</p>}
      {log.length > 0 && <pre className="nft-log">{log.join("\n")}</pre>}
    </div>
  );
}
