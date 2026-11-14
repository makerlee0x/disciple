/**
 * Shared fixtures for the e2e suite.
 *  - Every test gets its own client IP (x-real-ip, trusted because the e2e server runs with TRUSTED_PROXY=1), so the
 *    per-IP rate limits and the Daily flight's 5-runs-per-network cap never bleed between tests.
 *  - Requests that leave 127.0.0.1 are aborted (fonts, Privy, analytics, images on other hosts): runs stay offline and
 *    the same every time.
 *  - Uncaught page errors fail the test (`pageErrors`), so a crash or a hydration mismatch can't hide behind a green run.
 *  - `pilot` signs a fresh pilot in the way the local signer does (a key in localStorage), with the cash you ask for on
 *    the stand-in chain. Sign-in through the button is covered on its own in signin.spec.ts.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const CHAIN = `http://127.0.0.1:${process.env.E2E_CHAIN_PORT || 8545}`;
export const OWNER_KEY = "disciple.local.ownerKey.v1";

/** page errors that are known and not ours to fix here; keep this list short and say why */
const IGNORED_PAGE_ERRORS: RegExp[] = [
  /ResizeObserver loop/i, // browser noise, harmless
];

let ipSeq = 0;
const freshIp = () => { ipSeq += 1; const w = Number(process.env.TEST_PARALLEL_INDEX || 0); return `10.${(w % 200) + 1}.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`; };

export async function setCash(address: string, usd: number) {
  const r = await fetch(`${CHAIN}/__e2e/balance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, usd }) });
  if (!r.ok) throw new Error(`stand-in chain: couldn't set cash (${r.status})`);
}

export type Pilot = { key: `0x${string}`; address: string; signIn(o?: { cash?: number }): Promise<void> };

type Fixtures = { pageErrors: string[]; pilot: Pilot; ip: string };

export const test = base.extend<Fixtures>({
  ip: async ({}, use) => { await use(freshIp()); },
  context: async ({ context, ip }, use) => {
    await context.setExtraHTTPHeaders({ "x-real-ip": ip });
    await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.protocol.startsWith("http"), (route) => route.abort("blockedbyclient"));
    await use(context);
  },
  pageErrors: [async ({ page }, use, info) => {
    const errs: string[] = [];
    page.on("pageerror", (e) => { if (!IGNORED_PAGE_ERRORS.some((r) => r.test(e.message))) errs.push(e.message); });
    await use(errs);
    if (info.status === info.expectedStatus) expect(errs, "uncaught errors on the page").toEqual([]);
  }, { auto: true }],
  pilot: async ({ page }, use) => {
    const key = generatePrivateKey(), address = privateKeyToAccount(key).address;
    await use({
      key, address,
      async signIn(o = {}) {
        await setCash(address, o.cash ?? 0);
        await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } }, [OWNER_KEY, key] as const);
      },
    });
  },
});

export { expect };

/** phones in this suite are the "phone" project (Pixel 7) */
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 760;

/** wait until React has hydrated this element (its fiber is attached), so a click runs our handler, not the bare link */
export async function hydrated(el: import("@playwright/test").Locator) {
  await el.first().waitFor({ state: "attached" });
  await expect.poll(() => el.first().evaluate((n) => Object.keys(n).some((k) => k.startsWith("__reactFiber") || k.startsWith("__reactProps"))), { timeout: 15_000 }).toBe(true);
}

/** wait until fonts and the first paint settle, for screenshots */
export async function settle(page: Page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForLoadState("load");
  await page.waitForTimeout(400);
}
