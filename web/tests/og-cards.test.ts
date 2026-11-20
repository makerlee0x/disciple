import { describe, expect, it } from "vitest";
import { isPreviewBot, previewPage } from "@/lib/server/og/botPage";
import { bandOf, renderOgCard, tierName } from "@/lib/server/og/card";

describe("link preview cards", () => {
  it("spots preview crawlers, not people", () => {
    expect(isPreviewBot("Twitterbot/1.0")).toBe(true);
    expect(isPreviewBot("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)")).toBe(true);
    expect(isPreviewBot("WhatsApp/2.23.20.0")).toBe(true);
    expect(isPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isPreviewBot(null)).toBe(false);
  });

  it("escapes the crawler page and points it on", async () => {
    const r = previewPage({ title: `<b>"x"</b>`, description: "d", image: "https://disciple.vip/api/og/invite", url: "https://disciple.vip/i/ABCD2345", to: "https://disciple.vip/invite?code=ABCD2345" });
    const html = await r.text();
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;&quot;x&quot;");
    expect(html).toContain('og:image" content="https://disciple.vip/api/og/invite"');
    expect(html).toContain("http-equiv=\"refresh\"");
    // never stored by a shared cache: people on the same URL must get the redirect and the referral cookie
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("vary")).toBe("User-Agent");
  });

  it("picks the sky band from the rocket's value", () => {
    expect(bandOf(5_000)).toBe(1);
    expect(bandOf(20_000)).toBe(2);
    expect(bandOf(40_000)).toBe(3);
    expect(bandOf(500_000)).toBe(4);
    expect(bandOf(10e6)).toBe(5);
    expect(bandOf(5e9)).toBe(5);
    expect(tierName(20_000)).toBe("STRATOSPHERE");
  });

  it("draws every card as a 1200x630 JPEG, with or without numbers", async () => {
    const cards = [
      { kind: "site" as const },
      { kind: "rocket" as const, ticker: "EMBER", name: "Ember Wolf", host: "kiko", mcapUsd: 21_000, orbitPct: 62, graduated: false, aboard: 48, icon: null },
      { kind: "rocket" as const, ticker: "X", name: "X", host: null, mcapUsd: null, orbitPct: null, graduated: false, aboard: null, icon: null },
      { kind: "pilot" as const, handle: "kiko", level: 14, trophies: 9, hull: "violet" },
      { kind: "invite" as const, from: null },
    ];
    for (const c of cards) {
      const jpg = await renderOgCard(c);   // lib/server/og/card encodes JPEG (smaller to unfurl than PNG)
      expect(jpg[0]).toBe(0xff); expect(jpg[1]).toBe(0xd8);   // JPEG start of image
      expect(jpegSize(jpg)).toEqual({ w: 1200, h: 630 });
    }
  }, 30_000);
});

/** Width / height from the JPEG's first start-of-frame marker. */
function jpegSize(b: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
