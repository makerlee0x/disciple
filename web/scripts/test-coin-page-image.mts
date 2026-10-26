// Coin page header image (lib/coinPageImage): a direct /coin load resolves the coin's own stored image from its on-chain
// imageURI via the moderated-store allowlist; blocked / unknown URIs fall back to the letter placeholder; a crafted
// ?icon= can't override the verified result.  pnpm test:coin-page-image
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCoinIcon, resolveCoinStoredImage } from "../lib/coinPageImage";

const ID = "e8f6621c9a4ae3b17a0e2f082904500a69591be99eb3e3da2da5cab7d8dd755b";
const OTHER = "b38dcac3d31e838f4e7e61e7691b3f87ac3de288c9d0aac6f4ad862aad4fbe68";
const URL_ = `https://disciple-pearl.vercel.app/api/image/${ID}`;
// fake /api/image/resolve: only URL_ is allowlisted (mirrors lib/coinImages moderatedSrcs: unknown ⇒ "")
const allow = new Map([[URL_, `/api/image/${ID}`]]);
const resolve = async (uris: string[]) => new Map(uris.map((u) => [u, allow.get(u) ?? ""]));

test("direct /coin load (no ?icon=) resolves the stored https image", async () => {
  const s = await resolveCoinStoredImage(async () => URL_, resolve);
  assert.equal(s, `/api/image/${ID}`);
  assert.equal(pickCoinIcon(s, null), `/api/image/${ID}`);
});
test("blocked / unknown / empty on-chain URIs fall back to the placeholder", async () => {
  for (const u of ["https://evil.example/x.png", "data:image/png;base64,AAAA", `https://disciple-pearl.vercel.app/api/image/${OTHER}`, "ipfs://bafy", ""]) {
    const s = await resolveCoinStoredImage(async () => u, resolve);
    assert.equal(s, "", u);
    assert.equal(pickCoinIcon(s, null), null, u);
  }
});
test("resolver returning a non-store src is rejected", async () => {
  const bad = async (uris: string[]) => new Map(uris.map((u) => [u, "https://evil.example/x.png"]));
  assert.equal(await resolveCoinStoredImage(async () => URL_, bad), "");
});
test("?icon= can't override: verified image wins, unapproved coin image ⇒ placeholder", async () => {
  const s = await resolveCoinStoredImage(async () => URL_, resolve);
  assert.equal(pickCoinIcon(s, `/api/image/${OTHER}`), `/api/image/${ID}`);
  const u = await resolveCoinStoredImage(async () => "https://evil.example/x.png", resolve);
  assert.equal(pickCoinIcon(u, `/api/image/${OTHER}`), null);
  for (const q of ["https://evil.example/x.png", "data:image/png;base64,AAAA", `https://evil.example/api/image/${ID}`])
    assert.equal(pickCoinIcon(undefined, q), null, q);
});
test("while unresolved / chain read failed: only a store-gated ?icon= shows; demo icon kept", async () => {
  assert.equal(await resolveCoinStoredImage(async () => { throw new Error("rpc"); }, resolve), undefined);
  assert.equal(await resolveCoinStoredImage(async () => URL_, async () => { throw new Error("net"); }), undefined);
  assert.equal(pickCoinIcon(undefined, `/api/image/${ID}`), `/api/image/${ID}`);
  assert.equal(pickCoinIcon(undefined, null, "https://cdn/demo.png"), "https://cdn/demo.png");
  assert.equal(pickCoinIcon("", null, "https://cdn/demo.png"), "https://cdn/demo.png");
});
