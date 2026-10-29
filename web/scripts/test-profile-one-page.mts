// Titles (lee 2026-10-24, "choose which one gets displayed, like Guild Wars") + shared tooltip placement.
//   pnpm test:profile-one-page
import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITIES } from "../lib/identity.ts";
import { PERSONAS, buildPersonaStats, type PersonaId } from "../lib/mock/sample-trades.ts";
import { TITLE_ERRORS, TITLE_IDS, defaultTitle, earnedTitleIds, earnedTitlesFor, profileStatsSeed, shownTitle, validateTitle } from "../lib/titles.ts";
import { placeTooltip } from "../lib/tooltipPlace.ts";
import { profileMetaMessage, validateMeta } from "../lib/profileMeta.ts";
import { REAL_PROGRESS_ENABLED } from "../lib/features.ts";
import { NO_TITLE, deriveIdentity } from "../lib/identity.ts";

test("hidden until real progress exists: flag is off by default and nothing counts as earned", () => {
  assert.equal(REAL_PROGRESS_ENABLED, false, "REAL_PROGRESS_ENABLED defaults to off");
  for (const seed of ["maker", "0x00000000000000000000000000000000000000aa", ...Object.keys(PERSONAS)]) {
    assert.deepEqual(earnedTitlesFor(seed), [], `${seed}: no earned titles while hidden`);
    assert.equal(shownTitle("believer", earnedTitlesFor(seed)), null, "a saved pick isn't shown either");
  }
  assert.ok(earnedTitlesFor("believer", true).length > 0, "flag on: the sample stats would earn titles");
});

test("no title = Normie (label only; id stays the sigil key)", () => {
  assert.equal(NO_TITLE.label, "Normie");
  const none = deriveIdentity({} as Parameters<typeof deriveIdentity>[0]);
  if (!none.matched.length) assert.equal(none.primary.label, "Normie");
  assert.ok(!(TITLE_IDS as readonly string[]).includes("normie"), "Normie isn't pickable");
});

test("default title = highest-weight earned title (= the header's old first tag)", () => {
  for (const p of Object.keys(PERSONAS) as PersonaId[]) {
    const id = buildPersonaStats(p).identity;
    const earned = earnedTitleIds(id.matched);
    if (!earned.length) { assert.equal(defaultTitle(earned), null); continue; }
    assert.equal(defaultTitle(earned), id.primary.id, p);
    const w = earned.map((t) => IDENTITIES.find((d) => d.id === t)!.weight);
    assert.deepEqual(w, [...w].sort((a, b) => b - a), `${p}: best first`);
  }
  assert.equal(defaultTitle([]), null);
});

test("shown title: the pick when earned, else the default", () => {
  const earned = earnedTitleIds(buildPersonaStats("believer").identity.matched);
  assert.ok(earned.length >= 2, "fixture has several titles");
  assert.equal(shownTitle("", earned), earned[0]);
  assert.equal(shownTitle(earned[1], earned), earned[1]);
  const locked = TITLE_IDS.find((t) => !earned.includes(t))!;
  assert.equal(shownTitle(locked, earned), earned[0], "a no-longer-earned pick falls back to the default");
  assert.equal(shownTitle("nope", earned), earned[0]);
});

test("validation: earned ok, locked and unknown refused, empty = default", () => {
  const earned = earnedTitleIds(buildPersonaStats("believer").identity.matched);
  const locked = TITLE_IDS.find((t) => !earned.includes(t))!;
  assert.equal(validateTitle("", earned), null);
  for (const t of earned) assert.equal(validateTitle(t, earned), null);
  assert.equal(validateTitle(locked, earned), TITLE_ERRORS.locked);
  assert.equal(validateTitle("emperor", earned), TITLE_ERRORS.unknown);
  assert.equal(validateMeta({ pfp: "", bio: "", flag: "", title: "Bad Title!" }), "That title doesn't exist.");
});

test("server and page compute the same earned set for an address (seed = username, else wallet)", () => {
  const w = "0x00000000000000000000000000000000000000aa";
  assert.equal(profileStatsSeed("@Maker", w), "maker");
  assert.equal(profileStatsSeed(null, w.toUpperCase().replace("0X", "0x")), w);
  assert.deepEqual(earnedTitlesFor(profileStatsSeed("maker", w), true), earnedTitlesFor("maker", true));
  // Different wallets without names can earn different sets; each is stable.
  assert.deepEqual(earnedTitlesFor(w, true), earnedTitlesFor(w, true));
});

test("signed message covers the title, and is unchanged when there is none", () => {
  const m = { pfp: "", bio: "hi", flag: "US" };
  const a = profileMetaMessage("0xabc", m, "n1");
  assert.equal(profileMetaMessage("0xabc", { ...m, title: "" }, "n1"), a, "old clients / no title: same message");
  assert.match(profileMetaMessage("0xabc", { ...m, title: "believer" }, "n1"), /Title: believer\n/);
});

test("tooltip placement: above by default, flips below at the top edge, shifts inside the sides", () => {
  const vp = { width: 390, height: 800 }, tip = { width: 200, height: 60 };
  let p = placeTooltip({ left: 150, top: 300, width: 80, height: 24 }, tip, vp);
  assert.equal(p.side, "top"); assert.equal(p.y, 300 - 8 - 60); assert.equal(p.x, 90);
  p = placeTooltip({ left: 150, top: 20, width: 80, height: 24 }, tip, vp);
  assert.equal(p.side, "bottom"); assert.equal(p.y, 20 + 24 + 8);
  p = placeTooltip({ left: 2, top: 300, width: 20, height: 20 }, tip, vp);
  assert.equal(p.x, 8); assert.ok(p.arrow >= 12 && p.arrow <= 188);
  p = placeTooltip({ left: 370, top: 300, width: 20, height: 20 }, tip, vp);
  assert.equal(p.x, 390 - 8 - 200); assert.ok(p.x + tip.width <= vp.width - 8);
  assert.ok(Math.abs(p.x + p.arrow - 380) <= 1 || p.arrow === 188, "arrow points at the trigger");
});

test("server (hidden): /api/profile/meta refuses every title pick, even one the sample stats would earn (400, plain words)", async () => {
  process.env.KV_LOCAL_FILE = `/tmp/disciple-kv-titles-${process.pid}.json`;
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { GET, POST } = await import("../app/api/profile/meta/route.ts");
  const acct = privateKeyToAccount(generatePrivateKey()), a = acct.address.toLowerCase();
  assert.deepEqual(earnedTitlesFor(profileStatsSeed(null, a)), [], "hidden: nothing earned");
  const nonce = async () => (await (await GET(new Request(`http://x/api/profile/meta?nonce=1&address=${a}`))).json()).nonce as string;
  const save = async (title: string) => {
    const m = { pfp: "", bio: "", flag: "", title }, n = await nonce();
    return POST(new Request("http://x/api/profile/meta", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
      body: JSON.stringify({ address: a, ...m, nonce: n, signature: await acct.signMessage({ message: profileMetaMessage(a, m, n) }) }) }));
  };
  let r: Response;
  // One the sample stats would earn for this address, plus one they wouldn't (the route rate-limits, so not all 19).
  const wouldEarn = earnedTitlesFor(profileStatsSeed(null, a), true);
  const picks = [...new Set([wouldEarn[0] ?? TITLE_IDS[0], TITLE_IDS.find((t) => !wouldEarn.includes(t)) ?? TITLE_IDS[1]])];
  for (const t of picks) {
    r = await save(t);
    assert.equal(r.status, 400, t); assert.deepEqual(await r.json(), { ok: false, reason: "You haven't earned that title yet." });
  }
  r = await save("emperor");
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { ok: false, reason: "That title doesn't exist." });
  const g = await (await GET(new Request(`http://x/api/profile/meta?address=${a}`))).json();
  assert.ok(!g.title, "nothing saved");
  r = await save("");
  assert.equal(r.status, 200, "no pick (default) always saves");
});
