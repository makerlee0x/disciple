/**
 * Turbo (leverage mode, hidden behind the flag + the early-access password): the gate, a stand-in run (BOOST = long,
 * cash out → result), and the Trading duel lobby once PR #364's /turbo/duel is on main.
 */
import { test, expect } from "./support/fixtures";
import { fakeVenue } from "./support/venue";
import type { Page } from "@playwright/test";

const PASSWORD = "e2e-turbo";

async function pass(page: Page, path = "/turbo?sample=1") {
  await page.goto(path);
  const gate = page.getByTestId("turbo-gate");
  if (await gate.isVisible().catch(() => false)) {
    await page.getByTestId("turbo-gate-input").fill(PASSWORD);
    await page.getByTestId("turbo-gate-go").click();
    await expect(gate).toBeHidden();
  }
}

test("the early-access gate turns away a wrong password and lets the right one in", async ({ page }) => {
  await fakeVenue(page);
  await page.goto("/turbo?sample=1");
  await expect(page.getByTestId("turbo-gate")).toBeVisible();
  await page.getByTestId("turbo-gate-input").fill("not-it");
  await page.getByTestId("turbo-gate-go").click();
  await expect(page.getByTestId("turbo-gate")).toBeVisible();
  await expect(page.getByTestId("turbo-gate").getByRole("alert").or(page.getByTestId("turbo-gate").locator("[class*=err]"))).toBeVisible();
  await page.getByTestId("turbo-gate-input").fill(PASSWORD);
  await page.getByTestId("turbo-gate-go").click();
  await expect(page.getByTestId("turbo-screen")).toBeVisible();
});

test("a sample run: fuel tops up, BOOST opens a long, cash out shows the result", async ({ page, pilot }) => {
  await pilot.signIn();
  await fakeVenue(page);
  await pass(page);
  const screen = page.getByTestId("turbo-screen");
  await expect(screen).toBeVisible();
  await expect(page.getByTestId("turbo-standin-notice").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("turbo-fuel")).toHaveText(/\$100/);
  await expect(page.getByTestId("turbo-ready")).toBeVisible();
  await page.getByTestId("turbo-boost").click();
  await expect(page.getByTestId("turbo-hud")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("turbo-cashout")).toBeEnabled({ timeout: 15_000 });
  await page.waitForTimeout(1_500);
  await page.getByTestId("turbo-cashout").click();
  const res = page.getByTestId("turbo-result");
  await expect(res).toBeVisible({ timeout: 15_000 });
  await expect(res).toHaveAttribute("data-kind", "cashed");
  await expect(res.getByTestId("turbo-result-multiple")).toHaveText(/\d/);
  await res.getByTestId("turbo-result-close").click();
  await expect(page.getByTestId("turbo-ready")).toBeVisible();
});

test("Trading duel lobby opens (after PR #364 lands)", async ({ page, pilot }) => {
  await pilot.signIn();
  await fakeVenue(page);
  const r = await page.request.get("/turbo/duel");
  test.skip(r.status() === 404, "/turbo/duel isn't on this branch yet (PR #364)");
  await pass(page, "/turbo/duel?turbo=1");
  // the engine draws the lobby into its own root; it must mount without errors and offer a match
  await expect(page.getByText(/quick match|find a match|play a bot|ranked/i).first()).toBeVisible({ timeout: 15_000 });
});
