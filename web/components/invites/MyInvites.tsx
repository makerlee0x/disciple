"use client";
import { useState } from "react";
import { INVITE_COPY as C } from "@/lib/copy/invites";
import { inviteLink, type MyCode } from "@/lib/invitesClient";

/** "N invites left" + each code with its state, Copy link and Share (phone share sheet, else a post on X) (step 7 board, state d). Used codes are struck through. */
export default function MyInvites({ codes }: { codes: MyCode[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const left = codes.filter((c) => !c.used).length;
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(inviteLink(code)); setCopied(code); setTimeout(() => setCopied((x) => (x === code ? null : x)), 1500); }
    catch { /* clipboard blocked: the code is on screen */ }
  };
  // The phone share sheet where there is one; otherwise a post on X with the link.
  const share = async (code: string) => {
    const url = inviteLink(code), text = C["invites.shareText"];
    if (typeof navigator.share === "function") { try { await navigator.share({ text, url }); } catch { /* closed the sheet */ } return; }
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
  };
  return (
    <div data-testid="my-invites" className="iv-mine">
      <div className="iv-mhead">
        <div><span className="r2-eb iv-green">{C["in.eyebrow"]}</span><h1 className="r2-g">{left ? C["invites.count"](left) : C["invites.none"]}</h1></div>
        {left > 0 && <p>{C["invites.help"]}</p>}
      </div>
      <ul className="iv-list">
        {codes.map((c) => (
          <li key={c.code} className={`iv-row${c.used ? " used" : ""}`}>
            <span className="r2-mono iv-code">{c.code}</span>
            <span className="iv-st">{c.used ? C["invites.used"] : C["invites.unused"]}</span>
            {!c.used && <button type="button" className="r2-btn" onClick={() => void copy(c.code)}>{copied === c.code ? C["invites.copied"] : C["invites.copy"]}</button>}
            {!c.used && <button type="button" className="r2-btn r2-goldsm" onClick={() => void share(c.code)}>{C["invites.share"]}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
