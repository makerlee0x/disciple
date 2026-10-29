"use client";
/** Docs v1 draft chrome: draft banner + section sidebar (collapsible sheet on narrow screens). */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export type NavSection = { title: string; pages: { title: string; slug: string }[] };

export default function DocsShell({ sections, children }: { sections: NavSection[]; children: ReactNode }) {
  const pathname = (usePathname() || "/docs").replace(/\/+$/, "") || "/docs";
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [open]);
  const current = sections.find((s) => s.pages.some((p) => p.slug === pathname));

  return (
    <div className="dv-root">
      <div className="dv-banner" role="note">
        <span className="dv-banner-tag">Draft</span>
        <span className="dv-banner-txt">Draft docs, not final.<span className="dv-banner-more"> Details may change before launch.</span></span>
      </div>
      <div className="dv-mbar">
        <button type="button" className="dv-mbar-btn" aria-expanded={open} aria-controls="dv-side" onClick={() => setOpen((o) => !o)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          {open ? "Close" : "Sections"}
        </button>
        {current && <span className="dv-mbar-cur">{current.title}</span>}
      </div>
      <div className="dv-grid">
        {open && <button type="button" className="dv-scrim" aria-label="Close sections" onClick={() => setOpen(false)} />}
        <nav id="dv-side" className={`dv-side${open ? " is-open" : ""}`} aria-label="Docs sections">
          <Link href="/docs" className="dv-side-home">DISCIPLE Docs <span>v1 draft</span></Link>
          {sections.map((s) => (
            <div key={s.title} className="dv-side-sec">
              <h4>{s.title}</h4>
              <ul>
                {s.pages.map((p) => (
                  <li key={p.slug}>
                    <Link href={p.slug} className={p.slug === pathname ? "is-active" : undefined} aria-current={p.slug === pathname ? "page" : undefined}>{p.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="dv-side-bug">Found a security bug? <Link href="/security">Report a bug</Link></p>
        </nav>
        <div className="dv-main">{children}</div>
      </div>
    </div>
  );
}
