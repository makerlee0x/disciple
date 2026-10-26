// The launch imageURI is the absolute https content-addressed store URL, never data: / relative.  pnpm test:launch-image
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IMAGE_ORIGIN, IMAGE_COPY, LAUNCH_FAILED_MSG, imageOrigin, isLaunchImageUrl, launchImageFrom, launchImageUrl } from "../lib/launchImage";

const id = "0123456789abcdef".repeat(4);
const data = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvQWxvAGs=";

test("allowed + stored → absolute https sha URL on the prod origin", () => {
  const r = launchImageFrom({ verdict: "allow", sha256: "x", imageUri: `/api/image/${id}`, imageUrl: `${DEFAULT_IMAGE_ORIGIN}/api/image/${id}` });
  assert.deepEqual(r, { ok: true, uri: `https://disciple-pearl.vercel.app/api/image/${id}` });
  if (r.ok) { assert.ok(!r.uri.startsWith("data:")); assert.ok(r.uri.startsWith("https://")); assert.ok(isLaunchImageUrl(r.uri)); assert.ok(r.uri.length < 120); }
});
test("never data: or relative, whatever the server returns", () => {
  for (const imageUri of [data, `https://evil.example/api/image/${id}`, `/api/image/${id.slice(1)}`, `/api/image/${id}?v=2`, "", undefined]) {
    const r = launchImageFrom({ verdict: "allow", imageUri });
    assert.equal(r.ok, false, String(imageUri));
  }
  assert.equal(isLaunchImageUrl(data), false);
  assert.equal(isLaunchImageUrl(`/api/image/${id}`), false);
  assert.equal(isLaunchImageUrl(`http://disciple-pearl.vercel.app/api/image/${id}`), false);
  assert.throws(() => launchImageUrl("not-a-sha"));
});
test("block / review / outage / not stored stop the launch (no URI)", () => {
  assert.deepEqual(launchImageFrom({ verdict: "block", imageUri: `/api/image/${id}` }), { ok: false, reason: "block", detail: "blocked" });
  assert.equal((launchImageFrom({ verdict: "review" }) as { reason: string }).reason, "review");
  assert.equal((launchImageFrom(null) as { reason: string }).reason, "upload");
  assert.equal((launchImageFrom({ verdict: "allow" }) as { reason: string }).reason, "upload");
  assert.equal((launchImageFrom({ verdict: "allow", imageUri: `/api/image/${id}`, imageUrl: `https://other.example/api/image/${id}` }) as { reason: string }).reason, "upload");
});
test("origin: env override must be a bare https origin, else prod alias", () => {
  assert.equal(imageOrigin(undefined), DEFAULT_IMAGE_ORIGIN);
  assert.equal(imageOrigin("https://disciple.example/"), "https://disciple.example");
  for (const bad of ["http://x.example", "https://x.example/path", "javascript:alert(1)", " "]) assert.equal(imageOrigin(bad), DEFAULT_IMAGE_ORIGIN, bad);
  assert.equal(launchImageUrl(id, imageOrigin("https://disciple.example")), `https://disciple.example/api/image/${id}`);
});
test("player copy is plain (no jargon)", () => {
  assert.equal(LAUNCH_FAILED_MSG, "Launch didn't go through. Nothing was spent. Try again.");
  for (const s of [LAUNCH_FAILED_MSG, ...Object.values(IMAGE_COPY)]) assert.doesNotMatch(s, /on-?chain|relay|\btx\b|transaction|gas|paymaster|bundler|data:|0x/i, s);
});
