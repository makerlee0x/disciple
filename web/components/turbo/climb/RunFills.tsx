"use client";
/**
 * The run's own Lighter fills on the Climb result card (maker 2026-11-20: "after the missed or success screen it should
 * show you your fills"). Real money only: the engine adds #cFills to the card only for a run that placed real orders.
 * Fills from `since` on, read from the same record as the Turbo popup's Advanced tab, rows drawn the same way.
 * Lighter books a fill a moment after the close, so an empty read tries again a few times.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Row } from "@/components/turbo/TurboCashBody";
import type { HistoryItem } from "@/lib/lighter/history";
import { gaslessSigner, onWallet } from "@/lib/wallet";

export default function RunFills({ root, since }: { root: HTMLElement | null; since: number | null }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [addr, setAddr] = useState<string | null>(null);
  const [rows, setRows] = useState<HistoryItem[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => onWallet((a) => setAddr(a ?? null)), []);

  // the engine redraws the card's HTML on each result: follow #cFills as it comes and goes
  useEffect(() => {
    const cr = root?.querySelector<HTMLElement>("#cres");
    if (!cr) { setSlot(null); return; }
    const find = () => setSlot((cur) => { const el = cr.querySelector<HTMLElement>("#cFills"); return el === cur ? cur : el; });
    const mo = new MutationObserver(find);
    mo.observe(cr, { childList: true });
    find();
    return () => { mo.disconnect(); setSlot(null); };
  }, [root]);

  const owner = addr ? (gaslessSigner()?.address ?? addr).toLowerCase() : null;
  useEffect(() => {
    setRows(null); setErr(false);
    if (!slot || !owner || since == null) return;
    let gone = false;
    void (async () => {
      const [{ lighterFetcher }, { lighterHistory }] = await Promise.all([import("@/lib/lighter/duel"), import("@/lib/lighter/history")]);
      for (let k = 0; k < 4 && !gone; k++) {
        if (k) await new Promise((ok) => setTimeout(ok, 1500 * k));
        try {
          const h = await lighterHistory(lighterFetcher(owner));
          const f = h.items.filter((it) => it.kind === "fill" && it.at >= since - 2_000);
          if (gone) return;
          if (f.length || k === 3) { setRows(f); return; }
        } catch { if (k === 3 && !gone) setErr(true); }
      }
    })();
    return () => { gone = true; };
  }, [slot, owner, since]);

  if (!slot) return null;
  return createPortal(
    <div className="tc-adv cl-fills" data-testid="climb-run-fills">
      {err ? <div className="tc-empty">Couldn&apos;t load fills.</div>
        : rows == null ? <div className="tc-wait"><span className="r2-spin tc-spin" aria-label="Loading" /></div>
        : !rows.length ? <div className="tc-empty">No fills</div>
        : <ul className="tc-list">{rows.map((it, i) => <Row key={`${it.at}-${i}`} it={it} />)}</ul>}
    </div>,
    slot,
  );
}
