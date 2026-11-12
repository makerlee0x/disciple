/** GET /api/admin/funnel is team-only: same Privy + ADMIN_EMAILS gate as /api/admin/verifications, fail closed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/funnel/route";
import { POST } from "@/app/api/funnel/route";

afterEach(() => vi.unstubAllEnvs());
describe("funnel admin gate", () => {
  it("ADMIN_EMAILS unset ⇒ 503, never returns counts", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    const r = await GET(new Request("https://x.test/api/admin/funnel"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("totals");
  });
  it("ADMIN_EMAILS set but no session ⇒ refused", async () => {
    vi.stubEnv("ADMIN_EMAILS", "team@example.com");
    const r = await GET(new Request("https://x.test/api/admin/funnel"));
    expect([401, 403, 503]).toContain(r.status);
    expect(JSON.stringify(await r.json())).not.toContain("totals");
  });
});
describe("POST /api/funnel", () => {
  it("rejects unknown steps and bad bodies with 400", async () => {
    const bad = await POST(new Request("https://x.test/api/funnel", { method: "POST", body: JSON.stringify({ step: "visit" }) }));
    expect(bad.status).toBe(400);
    const junk = await POST(new Request("https://x.test/api/funnel", { method: "POST", body: "not json" }));
    expect(junk.status).toBe(400);
  });
});
