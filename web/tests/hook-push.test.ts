import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH_PREFS, pushCopy, readPrefs } from "@/lib/push";

describe("push alerts", () => {
  it("only orbit is on by default; unknown keys are ignored", () => {
    expect(DEFAULT_PUSH_PREFS).toEqual({ orbit: true, host: false, crew: false });
    expect(readPrefs({ host: true, evil: true, orbit: "yes" })).toEqual({ orbit: true, host: true, crew: false });
    expect(readPrefs(null)).toEqual(DEFAULT_PUSH_PREFS);
  });
  it("copy names what happened, never a trade", () => {
    const all = [pushCopy.orbit("HALO", "LAUNCH PAD"), pushCopy.host("LUMA", 50), pushCopy.crew("NOVA", "OUTER SPACE", 4)];
    expect(all[0].body).toBe("You boarded at the Launch Pad and were aboard for it. See its flight.");
    expect(all[2]).toEqual({ title: "[NOVA] flew to Outer Space", body: "Your crew's 4th rocket past the Kármán Line this week." });
    for (const m of all) expect(`${m.title} ${m.body}`).not.toMatch(/\b(buy|sell|dump|price|win it back|\$\d)/i);
  });
});
