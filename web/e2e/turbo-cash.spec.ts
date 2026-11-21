/**
 * Turbo cash (the Turbo popup, maker 2026-11-20): Cash -> Turbo cash and Turbo cash -> Cash, the browser side.
 * The e2e build has no Lighter and no Privy, so the page gets a stand-in session token (window.__privyDev, local-signer
 * builds only) and this spec answers /api/lighter itself, the way the server does (app/api/lighter/route.ts). Everything
 * else is the real code: the popup, the $6 minimum, the chain guard, and the pilot's own key signing the withdrawal,
 * which the stand-in checks really is the pilot's signature before it says yes.
 */
import { test, expect } from "./support/fixtures";
import type { Page, Route } from "@playwright/test";
import { recoverMessageAddress, type Hex } from "viem";

type Lighter = {
  status: Record<string, unknown>;
  calls: { op: string; body: Record<string, unknown> }[];
  answer?: (op: string, body: Record<string, unknown>) => { status?: number; json: Record<string, unknown> } | undefined;
};

async function standInLighter(page: Page, l: Lighter, pilot: string) {
  await page.addInitScript(() => {
    try { localStorage.setItem("disciple.lighter", "1"); } catch { /* blocked */ }
    // a stand-in Privy session as soon as the page defines the hook (lib/aa/sessionState)
    const t = setInterval(() => { const f = (window as unknown as { __privyDev?: (t: string) => void }).__privyDev; if (f) { f("e2e-token"); clearInterval(t); } }, 20);
  });
  await page.route("**/api/lighter", async (route: Route) => {
    const req = route.request();
    const json = (status: number, j: Record<string, unknown>) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(j) });
    if (req.headers()["x-wallet"] !== pilot.toLowerCase()) return json(403, { ok: false, reason: "That wallet isn't on this login." });
    if (req.method() === "GET") return json(200, { ok: true, ...l.status });
    const body = JSON.parse(req.postData() || "{}") as Record<string, unknown>;
    const op = String(body.op);
    l.calls.push({ op, body });
    const a = l.answer?.(op, body);
    if (a) return json(a.status ?? 200, a.json);
    return json(400, { ok: false, reason: "Unknown op." });
  });
}

async function openTurbo(page: Page, tab: "add" | "out" | "history" = "add") {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __privyDev?: unknown }).__privyDev);
  // the popup's host is a lazy chunk (components/AppShell): keep asking until it is listening, the way the Hangar's
  // Transfer button and the Turbo pill open it (lib/turbo/turboPill openTurbo)
  const pop = page.getByTestId("turbo-popup");
  await expect.poll(async () => {
    if (!(await pop.isVisible())) await page.evaluate((t) => window.dispatchEvent(new CustomEvent("disciple:openturbo", { detail: { tab: t } })), tab);
    return pop.isVisible();
  }, { timeout: 20_000 }).toBe(true);
  return pop;
}

/** Withdraw shows once the Lighter read says cash can come back (as on the Turbo page, whose Withdraw button waits for it) */
async function openWithdraw(page: Page) {
  const pop = await openTurbo(page);
  await expect(pop.getByTestId("turbo-pop-balance")).toContainText("$40.50");
  await pop.getByTestId("turbo-tab-out").click();
  await expect(pop.getByTestId("turbo-tab-out")).toHaveAttribute("aria-selected", "true");
  return pop;
}

const READY = { network: "mainnet", step: "ready", account: 1234, collateral: "40.50", withdraw: true, mins: { minNew: 6, min: 6 }, feeBp: 0.05 };

test("the popup shows Turbo cash and Cash apart, and Add cash holds to the $6 minimum", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 20 });
  const l: Lighter = { status: READY, calls: [] };
  await standInLighter(page, l, pilot.address);
  const pop = await openTurbo(page);
  await expect(pop.getByTestId("turbo-pop-balance")).toContainText("$40.50");
  await expect(pop.getByTestId("turbo-pop-cash")).toContainText("$20.00");
  const amt = pop.getByTestId("cash-turbo-amount"), btn = pop.getByTestId("cash-turbo-btn");
  await amt.fill("5.99");
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveText("$6.00 minimum deposit");
  await amt.fill("6");
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveText("Move $6.00 to Turbo");
  // more than the Cash there is: refused on the spot, nothing asked of the server
  await amt.fill("25");
  await btn.click();
  await expect(pop.getByRole("alert")).toHaveText("That's more than you have. You can cash out up to $20.00.");
  expect(l.calls.filter((c) => c.op === "deposit-address")).toHaveLength(0);
});

test("a deposit address for another chain is never paid: Add stops before any cash leaves", async ({ page, pilot }) => {
  // 2026-11-18: a testnet build once sent test USDG to a real Lighter main address (lib/lighter/deposit chain guard)
  await pilot.signIn({ cash: 20 });
  const l: Lighter = {
    status: READY, calls: [],
    answer: (op) => (op === "deposit-address" ? { json: { ok: true, address: "0x2222222222222222222222222222222222222222", minNew: 6, min: 6, chainId: 4663, outUsd: 9.96 } } : undefined),
  };
  await standInLighter(page, l, pilot.address);
  const gasless: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/gasless") && r.method() === "POST") gasless.push(r.postData() ?? ""); });
  const pop = await openTurbo(page);
  await pop.getByTestId("cash-turbo-amount").fill("10");
  await pop.getByTestId("cash-turbo-btn").click();
  const alert = pop.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText(/nothing was sent|can't be added from this build/i);
  expect(l.calls.map((c) => c.op)).toContain("deposit-address");
  expect(l.calls.find((c) => c.op === "deposit-address")?.body.usd).toBe(10);
  // no cash-out was signed or sent (a quote may be read for the fee line; a submit never)
  expect(gasless.filter((b) => /disciple_gaslessWithdraw"/.test(b))).toHaveLength(0);
  await expect(pop.getByTestId("turbo-pop-cash")).toContainText("$20.00");
});

test("Withdraw: Lighter's message is signed by the pilot's own key and the money lands in Cash", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 3 });
  const msg = "Lighter transfer 10000000 to pool 9, nonce 41";
  let signedBy = null as string | null;
  const l: Lighter = {
    status: READY, calls: [],
    answer: (op, b) => {
      if (op === "withdraw-info") return { json: { ok: true, usd: 40.4, fee: 0.1, min: 4 } };
      if (op === "withdraw-start") return { json: { ok: true, message: msg, usd: b.usd, fee: 0.1 } };
      return undefined;
    },
  };
  await standInLighter(page, l, pilot.address);
  // withdraw-finish: only a real signature from this pilot's key goes through
  await page.route("**/api/lighter", async (route) => {
    const b = JSON.parse(route.request().postData() || "{}") as { op?: string; sig?: string };
    if (b.op !== "withdraw-finish") return route.fallback();
    l.calls.push({ op: "withdraw-finish", body: b });
    signedBy = await recoverMessageAddress({ message: msg, signature: b.sig as Hex }).catch(() => null);
    const ok = signedBy?.toLowerCase() === pilot.address.toLowerCase();
    await route.fulfill({ status: ok ? 200 : 403, contentType: "application/json", body: JSON.stringify(ok ? { ok: true, usd: 10, to: pilot.address } : { ok: false, reason: "That signature isn't from your wallet." }) });
  });
  const pop = await openWithdraw(page);
  await expect(pop.getByText("You can move $40.40")).toBeVisible();
  // Lighter's transfer fee shows on its own row
  await expect(pop.locator(".cx-fee")).toHaveText("$0.10");
  await pop.getByTestId("cash-back-amount").fill("10");
  const btn = pop.getByTestId("cash-back-btn");
  await expect(btn).toHaveText("Move $10.00 to Cash");
  await btn.click();
  await expect(pop.getByRole("status").filter({ hasText: "on its way" })).toHaveText("$10.00 on its way to Cash.");
  expect(signedBy?.toLowerCase()).toBe(pilot.address.toLowerCase());
  const start = l.calls.find((c) => c.op === "withdraw-start")!;
  expect(start.body).toMatchObject({ usd: 10, to: pilot.address, raw: false });
});

test("Withdraw refusals read in plain words, with Turbo in place of Lighter", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 3 });
  const l: Lighter = {
    status: READY, calls: [],
    answer: (op) => {
      if (op === "withdraw-info") return { json: { ok: true, usd: 3, fee: 0.1, min: 4 } };
      if (op === "withdraw-start") return { status: 400, json: { ok: false, reason: "Move at least $4." } };
      return undefined;
    },
  };
  await standInLighter(page, l, pilot.address);
  const pop = await openWithdraw(page);
  await pop.getByTestId("cash-back-amount").fill("5");
  await pop.getByTestId("cash-back-btn").click();
  // more than can move: refused before the server is asked
  await expect(pop.getByRole("alert")).toHaveText("That's more than you have. You can cash out up to $3.00.");
  expect(l.calls.filter((c) => c.op === "withdraw-start")).toHaveLength(0);
  await pop.getByTestId("cash-back-amount").fill("2");
  await pop.getByTestId("cash-back-btn").click();
  await expect(pop.getByRole("alert")).toHaveText("Move at least $4.");
  await expect(pop.getByRole("alert")).not.toHaveText(/Lighter|HTTP|undefined|\[object/);
  await expect(pop.getByTestId("turbo-pop-balance")).toContainText("$40.50");
});

test("with Turbo cash back closed (Lighter main before LIGHTER_PAYOUT_CHAIN), there is no Withdraw tab", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 3 });
  const l: Lighter = { status: { ...READY, withdraw: false }, calls: [] };
  await standInLighter(page, l, pilot.address);
  const pop = await openTurbo(page, "out");
  await expect(pop.getByTestId("turbo-tab-add")).toHaveAttribute("aria-selected", "true");
  await expect(pop.getByTestId("turbo-tab-out")).toHaveCount(0);
});

test("a pilot with no Turbo account yet: the first deposit's minimum applies", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 50 });
  const l: Lighter = { status: { ...READY, step: "deposit", collateral: "0", withdraw: true, mins: { minNew: 8, min: 6 } }, calls: [] };
  await standInLighter(page, l, pilot.address);
  const pop = await openTurbo(page);
  await expect(pop.getByTestId("turbo-pop-balance")).toContainText("$0.00");
  await pop.getByTestId("cash-turbo-amount").fill("7");
  await expect(pop.getByTestId("cash-turbo-btn")).toHaveText("$8.00 minimum deposit");
  // set-up isn't finished, so nothing can come back yet
  await expect(pop.getByTestId("turbo-tab-out")).toHaveCount(0);
});
