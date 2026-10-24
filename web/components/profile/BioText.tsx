import { linkify } from "@/lib/linkify";

/** A bio as plain text with http(s) links auto-linked (new tab, no referrer / opener, nofollow). No HTML is injected. */
export default function BioText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p, i) => p.kind === "link"
        ? <a key={i} className="pf-bio-link" href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.text}</a>
        : <span key={i}>{p.text}</span>)}
    </>
  );
}
