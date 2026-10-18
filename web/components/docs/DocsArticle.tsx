/** Server-rendered docs page: article (60ch), "On this page" rail from the h2/h3s, prev/next. */
import Link from "next/link";
import type { DocMeta, DocPage, DocSection } from "@/lib/docs/content";

export default function DocsArticle({ page, prev, next, sections }: { page: DocPage; prev: DocMeta | null; next: DocMeta | null; sections?: DocSection[] }) {
  const toc = page.toc;
  return (
    <div className="dv-page">
      <article className="dv-article">
        <div className="dv-crumb">{page.section}</div>
        <h1 className="dv-h1" dangerouslySetInnerHTML={{ __html: page.titleHtml }} />
        {toc.length > 0 && (
          <details className="dv-toc-m">
            <summary>On this page</summary>
            <ul>{toc.map((t) => <li key={t.id} className={`d${t.depth}`}><a href={`#${t.id}`}>{t.text}</a></li>)}</ul>
          </details>
        )}
        <div className="dv-body" dangerouslySetInnerHTML={{ __html: page.html }} />
        {sections && (
          <section className="dv-index" aria-label="All sections">
            <h2 id="all-sections">All sections</h2>
            <div className="dv-index-grid">
              {sections.map((s) => (
                <div key={s.title} className="dv-index-card">
                  <h3>{s.title}</h3>
                  <ul>{s.pages.map((p) => <li key={p.slug}><Link href={p.slug}>{p.title}</Link></li>)}</ul>
                </div>
              ))}
            </div>
          </section>
        )}
        <nav className="dv-pn" aria-label="Previous and next page">
          {prev ? <Link href={prev.slug} className="dv-pn-prev"><span>Previous</span>{prev.title}</Link> : <span />}
          {next ? <Link href={next.slug} className="dv-pn-next"><span>Next</span>{next.title}</Link> : <span />}
        </nav>
      </article>
      {toc.length > 0 && (
        <aside className="dv-toc" aria-label="On this page">
          <h4>On this page</h4>
          <ul>{toc.map((t) => <li key={t.id} className={`d${t.depth}`}><a href={`#${t.id}`}>{t.text}</a></li>)}</ul>
        </aside>
      )}
    </div>
  );
}
