/** GET /api/admin/stats is Team only: same Privy + ADMIN_EMAILS gate as /api/admin/funnel, fail closed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/stats/route";

afterEach(() => vi.unstubAllEnvs());
describe("admin stats gate", () => {
  it("ADMIN_EMAILS unset ⇒ 503, no stats", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    const r = await GET(new Request("https://x.test/api/admin/stats"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("launches");
  });
  it("ADMIN_EMAILS set but no session ⇒ refused", async () => {
    vi.stubEnv("ADMIN_EMAILS", "team@example.com");
    const r = await GET(new Request("https://x.test/api/admin/stats"));
    expect([401, 403, 503]).toContain(r.status);
    expect(JSON.stringify(await r.json())).not.toContain("launches");
  });
});
