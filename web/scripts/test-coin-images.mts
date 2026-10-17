// Unit tests for the moderated-store render gate (W-3e, lib/coinImages).  pnpm test:coin-images
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isStoreSrc, moderatedSrcs, uriKey } from "../lib/coinImages";

test("client allowlist key = server sha256(uri)", async () => {
  const u = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvQWxvAGs=";
  assert.equal(await uriKey(u), createHash("sha256").update(u).digest("hex"));
});
test("only /api/image/<sha256> passes as ?icon=", () => {
  const id = "a".repeat(64);
  assert.ok(isStoreSrc(`/api/image/${id}`));
  for (const bad of [null, "", "https://evil.example/x.png", "data:image/png;base64,AAAA", `/api/image/${id}?x=1`, `//evil.example/api/image/${id}`, `https://evil.example/api/image/${id}`, `/api/image/${"a".repeat(63)}`, `/other/api/image/${id}`, "javascript:alert(1)"])
    assert.equal(isStoreSrc(bad), false, String(bad));
});
test("outside the browser nothing is treated as moderated (fail closed)", async () => {
  const m = await moderatedSrcs(["https://evil.example/x.png", "data:image/png;base64,AAAA"]);
  assert.deepEqual(Array.from(m.values()), ["", ""]);
});
