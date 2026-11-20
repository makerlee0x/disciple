import { describe, expect, it } from "vitest";
import { fullCsp, securityHeaders } from "../securityHeaders.mjs";

// Next matches header sources with path-to-regexp; mirror the negative lookahead used for "every path except /duel"
const notDuel = /^\/((?!duel$).*)$/;

describe("security headers", () => {
  it("frames: every page but /duel is same-origin only, /duel allows X", () => {
    const [all, duel] = securityHeaders({ NODE_ENV: "production" });
    for (const p of ["/", "/turbo/duel", "/duels", "/coin/0xabc", "/turbo/royale/play.html"]) expect(notDuel.test(p)).toBe(true);
    expect(notDuel.test("/duel")).toBe(false);
    expect(all.headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" });
    expect(duel.source).toBe("/duel");
    expect(duel.headers.find((h) => h.key === "X-Frame-Options")).toBeUndefined();
    expect(duel.headers.find((h) => h.key === "Content-Security-Policy")?.value).toContain("https://x.com");
  });

  it("full CSP allows Privy and the env RPC, no eval in production", () => {
    const csp = fullCsp({ NODE_ENV: "production", NEXT_PUBLIC_RH_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/key" });
    expect(csp).toContain("frame-src 'self' https://auth.privy.io");
    expect(csp).toContain("https://robinhood-mainnet.g.alchemy.com");
    expect(csp).not.toContain("/v2/key");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("report-uri /api/csp-report");
  });
});
