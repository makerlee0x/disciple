"use client";

import { useId, useMemo, useState } from "react";
import { COUNTRY_CODES } from "@/lib/profileMeta";
import { COMMUNITY_FLAGS } from "@/lib/flags/community";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { searchFlags } from "@/lib/flags/search";
import Flag, { countryName, flagName } from "./Flag";

/**
 * Flag picker: "No flag", then Communities (lib/flags/community) and Countries, one search box over both.
 * Optional; the player picks. Values are flag ids validated again on the server (lib/profileMeta.isFlag).
 */
export default function FlagPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const listId = useId();
  const countries = useMemo(() => COUNTRY_CODES.map((c) => ({ id: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label)), []);
  const needle = q.trim();
  // Case-insensitive, aliases ("america", "uk", "holland" …) and best match first: lib/flags/search.
  const community = searchFlags(needle, COMMUNITY_FLAGS);
  const country = searchFlags(needle, countries);
  const pick = (id: string) => { onChange(id); setOpen(false); setQ(""); };

  const option = (id: string, label: string) => (
    <li key={id || "none"}>
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
          <ul className="pf-flag-list" role="listbox" aria-label={C["edit.flag.label.any"]}>
            {!needle && option("", C["edit.flag.none"])}
            {community.length > 0 && <li className="pf-flag-section" role="presentation">{C["edit.flag.section.community"]}</li>}
            {community.map((f) => option(f.id, f.label))}
            {country.length > 0 && <li className="pf-flag-section" role="presentation">{C["edit.flag.section.country"]}</li>}
            {country.map((f) => option(f.id, f.label))}
            {!community.length && !country.length && <li className="pf-flag-section muted" role="presentation">{C["edit.flag.empty"]}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
