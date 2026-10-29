"use client";
import { useState } from "react";
import { INVITE_COPY as C } from "@/lib/copy/invites";
import { inviteLink, type MyCode } from "@/lib/invitesClient";

/** "You have N invites" + each code with its state and a copy-link button. */
export default function MyInvites({ codes }: { codes: MyCode[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const left = codes.filter((c) => !c.used).length;
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(inviteLink(code)); setCopied(code); setTimeout(() => setCopied((x) => (x === code ? null : x)), 1500); }
    catch { /* clipboard blocked: the code is on screen */ }
  };
  return (
    <div data-testid="my-invites">
      <h3 className="cl-display xs">{left ? C["invites.count"](left) : C["invites.none"]}</h3>
      {left > 0 && <p className="muted cl-fine">{C["invites.help"]}</p>}
      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 }}>
        {codes.map((c) => (
          <li key={c.code} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="cl-mono" style={{ fontSize: 15, letterSpacing: ".12em", opacity: c.used ? 0.45 : 1, textDecoration: c.used ? "line-through" : "none" }}>{c.code}</span>
            <span className="muted cl-fine" style={{ margin: 0 }}>{c.used ? C["invites.used"] : C["invites.unused"]}</span>
            {!c.used && <button type="button" className="cl-btn sm ghost" onClick={() => void copy(c.code)}>{copied === c.code ? C["invites.copied"] : C["invites.copy"]}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
