/**
 * Lee, Nov 12 2026: nothing on the site says testnet (no tag, pill, card, subtitle, banner or settings line).
 * Fails if a player-visible "testnet" / "test net" / "Test network" string comes back in site UI copy:
 * string literals and JSX text in app/ (not app/api), components/, and the page copy in content/ (how-it-works,
 * security, legal). Comments, identifiers, env names and RPC/explorer hostnames are not on screen and are ignored.
 * Docs markdown (content/docs) is BRAND's (#321) and is not checked here.
 *   pnpm test:no-testnet-labels
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BANNED = /\btest[\s-]?net\b|\btestnets?\b|\btest network\b/i;
const HOSTS = /(rpc|explorer|faucet)\.testnet\.chain\.robinhood\.com/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && p !== path.join(ROOT, "app/api")) walk(p, out); }
    else if (/\.(tsx?|md)$/.test(n)) out.push(p);
  }
  return out;
}

/** Strip comments (block, JSX block, line) without touching "//" inside strings or URLs. */
function stripComments(src: string): string {
  let out = "", i = 0, q: string | null = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) { out += c; if (c === "\\") { out += d ?? ""; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "/" && d === "/" && src[i - 1] !== ":") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    out += c; i++;
  }
  return out;
}

/** Visible-text candidates: quoted strings, template strings, and JSX text between tags. */
function visibleText(src: string): string[] {
  const s = stripComments(src);
  const out: string[] = [];
  for (const m of s.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of s.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out;
}

const files = [
  ...walk(path.join(ROOT, "app")).filter((f) => !f.endsWith(".md")),
  ...walk(path.join(ROOT, "components")),
  path.join(ROOT, "content/how-it-works.ts"),
  path.join(ROOT, "content/security.md"),
  ...walk(path.join(ROOT, "content/legal")),
];

test("no player-visible testnet / Test network string in site UI copy", () => {
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const texts = f.endsWith(".md") ? [src] : visibleText(src);
    for (const t of texts) {
      const clean = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(HOSTS, "");   // CSS comments inside <style> template strings aren't on screen
      if (BANNED.test(clean)) hits.push(`${path.relative(ROOT, f)}: ${clean.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(hits, [], `visible testnet copy is back:\n${hits.join("\n")}`);
});

test("wallet strip has no Test network tag, and Settings does not call the wallet a testnet wallet", () => {
  const wb = readFileSync(path.join(ROOT, "components/WalletButton.tsx"), "utf8");
  assert.ok(!/Test network|wb-testnet/.test(wb), "WalletButton must not render a Test network tag");
  const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  assert.ok(!/\.wb-testnet/.test(css), "no .wb-testnet styles");
  const st = readFileSync(path.join(ROOT, "components/account/AccountSettings.tsx"), "utf8");
  assert.ok(!/Testnet wallet/i.test(st), "Settings must not say Testnet wallet");
  assert.ok(/Your wallet is stored in this browser\./.test(st), "Settings keeps the plain wallet-storage line");
});

test("How it works: no testnet FAQ, footer or referral line", () => {
  const hiw = readFileSync(path.join(ROOT, "content/how-it-works.ts"), "utf8");
  assert.ok(!/Is this live\?/.test(hiw), "the testnet-only FAQ item stays removed");
  assert.ok(/footer: "DISCIPLE runs on Robinhood Chain\. It is not audited\. Nothing here is financial advice\."/.test(hiw));
});
