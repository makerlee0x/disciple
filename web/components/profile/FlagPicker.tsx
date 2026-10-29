"use client";

import { useId, useMemo, useState } from "react";
import { COUNTRY_CODES } from "@/lib/profileMeta";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Flag, { countryName, flagName } from "./Flag";

/**
 * Country flag picker: "No flag", then countries, with a search box. Coin communities moved to the guild picker (Guilds V1).
 * Optional; the player picks. Values are flag ids validated again on the server (lib/profileMeta.isFlag).
 */
export default function FlagPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const listId = useId();
  const countries = useMemo(() => COUNTRY_CODES.map((c) => ({ id: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label)), []);
  const needle = q.trim().toLowerCase();
  const match = (f: { id: string; label: string }) => !needle || f.label.toLowerCase().includes(needle) || f.id.toLowerCase().replace(/^c-/, "").includes(needle);
  const country = countries.filter(match);
  const pick = (id: string) => { onChange(id); setOpen(false); setQ(""); };

  const Option = ({ id, label }: { id: string; label: string }) => (
    <li>
      <button type="button" role="option" aria-selected={value === id} className={`pf-flag-opt ${value === id ? "on" : ""}`} onClick={() => pick(id)}>
        {id ? <Flag cc={id} size={14} /> : <span className="pf-flag-none" aria-hidden />}<span>{label}</span>
      </button>
    </li>
  );

  return (
    <div className="pf-flag-picker" data-testid="flag-picker">
      <div className="pf-input-wrap pf-flag-current">
        {value ? <Flag cc={value} size={16} /> : null}
        <span className="pf-flag-current-name">{value ? flagName(value) : C["edit.flag.none"]}</span>
        <button type="button" className="ds-btn pf-btn-text" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>{C["edit.flag.change"]}</button>
      </div>
      {open && (
        <div className="pf-flag-panel" id={listId}>
          <input className="pf-input pf-flag-search" type="search" value={q} placeholder={C["edit.flag.search"]} aria-label={C["edit.flag.search"]}
            autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
          <ul className="pf-flag-list" role="listbox" aria-label={C["edit.flag.label"]}>
            {!needle && <Option id="" label={C["edit.flag.none"]} />}
            {country.map((f) => <Option key={f.id} id={f.id} label={f.label} />)}
            {!country.length && <li className="pf-flag-section muted" role="presentation">{C["edit.flag.empty"]}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
