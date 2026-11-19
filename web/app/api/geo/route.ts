/** GET → { country } the visitor's country from Vercel's edge (lib/turbo/region: real-money Turbo is off where Lighter refuses) */
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  const c = (req.headers.get("x-vercel-ip-country") || "").toUpperCase();
  return Response.json({ country: /^[A-Z]{2}$/.test(c) ? c : null }, { headers: { "cache-control": "no-store" } });
}
