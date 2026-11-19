/** Host a launch: the builder (launch flow board, signed off 2026-11-13) and what happens when you light the engines. */
import { test, expect, hydrated } from "./support/fixtures";

test("the pad preview follows what you type and pick", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "Launch control" })).toBeVisible();
  await page.getByRole("textbox", { name: /name/i }).first().fill("E2E Comet");
  await expect(page.getByTestId("pad-name")).toContainText("E2E COMET", { ignoreCase: true });
  await page.getByTestId("mode-card-hard").click();
  await expect(page.getByTestId("mode-card-hard")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("pad-mode")).toContainText(/hard/i);
  // testnet (no all-difficulty anon contracts): an anon launch flies on Expert, with no line saying so
  await page.getByTestId("private-launch").click();
  await expect(page.getByTestId("private-launch")).toContainText("Anon launch");
  await expect(page.getByTestId("pad-mode")).toContainText(/expert/i);
});

test("a rocket needs a name before it can launch", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await page.getByRole("textbox", { name: /name/i }).first().fill("");
  await page.getByTestId("create-launch").click();
  await expect(page.getByRole("status").filter({ hasText: /name/i }).first()).toHaveText(/Give your rocket a name and a ticker\./);
});

test("Advanced holds host fees and the creator tax stepper", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await page.getByTestId("advanced-open").click();
  const m = page.getByTestId("advanced-modal");
  await expect(m).toBeVisible();
  const tax = m.getByTestId("creator-tax-value"), before = await tax.textContent();
  await m.getByRole("button", { name: "Raise creator tax" }).click();
  await expect(tax).not.toHaveText(before!);
  await m.getByRole("button", { name: "Close" }).click();
  await expect(m).toBeHidden();
  await expect(page.getByTestId("fee-destination-chip")).toBeVisible();
});

test("lighting the engines when the chain says no ends in plain words, with the form kept", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await page.getByRole("textbox", { name: /name/i }).first().fill("E2E Comet");
  const go = page.getByTestId("create-launch");
  await go.click();
  const status = page.getByRole("status").filter({ hasNotText: /^$/ }).last();
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(go).toHaveText(/Light the engines/, { timeout: 30_000 });
  await expect(status).not.toHaveText(/undefined|\[object|0x[0-9a-f]{8}|revert|execution|relayer|HTTP \d|rpc/i);
  await expect(page.getByTestId("launch-live")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /name/i }).first()).toHaveValue("E2E Comet");
});

test("signed out, the launch button signs you in", async ({ page }) => {
  await page.goto("/create");
  const btn = page.getByTestId("create-sign-in");
  await expect(btn).toBeVisible();
  await hydrated(btn);
  await btn.click();
  await expect(page.getByTestId("create-launch")).toBeVisible();
});

test("right after a launch the flight opens with the trade bar and a small share toast, no share screen", async ({ page, pilot }) => {
  const COIN = "0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d";
  await pilot.signIn({ cash: 25 });
  // what /create leaves behind when the launch lands (lib/launchHandoff.ts), then it goes straight to the flight
  await page.addInitScript((c) => {
    try { sessionStorage.setItem(`disciple:launched:${c}`, JSON.stringify({ name: "E2E Comet", ticker: "COMET", mode: "Easy", note: null, at: Date.now() })); } catch { /* blocked */ }
  }, COIN);
  await page.goto(`/coin/${COIN}`);
  const toast = page.getByTestId("launched-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/\$COMET is flying/i);
  await expect(page.getByTestId("trade-bar").filter({ visible: true }).first()).toBeVisible();
  // (phones: the first flight's How to fly card is gone; a finger on the lever teaches instead and blocks nothing)
  await toast.getByRole("button", { name: "Close" }).click();
  await expect(toast).toHaveCount(0);
});
