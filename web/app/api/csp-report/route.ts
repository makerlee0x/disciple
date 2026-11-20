/** POST ← browser CSP violation reports (securityHeaders.mjs, Report-Only for now). Logged as one "[csp]" line each, so
 *  Vercel logs show which hosts the full policy would block before it is enforced. Never stores anything. */
export const dynamic = "force-dynamic";

type R = Record<string, unknown>;
const s = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");

export async function POST(req: Request) {
  const text = (await req.text().catch(() => "")).slice(0, 8_000);
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 204 }); }
  // report-uri sends { "csp-report": {...} }; the Reporting API sends [{ type, body: {...} }]
  const list: R[] = Array.isArray(body) ? body.map((x) => (x as R)?.body as R).filter(Boolean) : [((body as R)?.["csp-report"] as R) || (body as R)];
  for (const r of list.slice(0, 5)) {
    const dir = s(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"], 40);
    const blocked = s(r["blocked-uri"] ?? r.blockedURL);
    const page = s(r["document-uri"] ?? r.documentURL).replace(/\?.*$/, "");
    if (dir || blocked) console.warn(`[csp] ${dir} blocked=${blocked} page=${page}`);
  }
  return new Response(null, { status: 204 });
}
