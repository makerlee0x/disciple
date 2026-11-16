/**
 * Turbo (on for everyone since 2026-11-16, still behind the early-access password): the gate, the archived solo /turbo link landing on
 * Trading Duel, and the duel lobby. The solo run was archived 2026-11-16 (only Duels and Royale remain).
 */
import { test, expect } from "./support/fixtures";
import { fakeVenue } from "./support/venue";
import type { Page } from "@playwright/test";

const PASSWORD = "e2e-turbo";

async function pass(page: Page, path = "/turbo/duel?turbo=1") {
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
  await page.goto("/turbo/duel?turbo=1");
  await expect(page.getByTestId("turbo-gate")).toBeVisible();
  await page.getByTestId("turbo-gate-input").fill("not-it");
  await page.getByTestId("turbo-gate-go").click();
  await expect(page.getByTestId("turbo-gate")).toBeVisible();
  await expect(page.getByTestId("turbo-gate").getByRole("alert").or(page.getByTestId("turbo-gate").locator("[class*=err]"))).toBeVisible();
  await page.getByTestId("turbo-gate-input").fill(PASSWORD);
  await page.getByTestId("turbo-gate-go").click();
  await expect(page.getByTestId("turbo-gate")).toBeHidden();
});

test("the old solo /turbo link lands on Trading Duel", async ({ page, pilot }) => {
  await pilot.signIn();
  await fakeVenue(page);
  await pass(page);
  await page.goto("/turbo?turbo=1");
  await expect(page).toHaveURL(/\/turbo\/duel\?turbo=1$/);
});

test("Trading duel lobby opens (after PR #364 lands)", async ({ page, pilot }) => {
  await pilot.signIn();
  await fakeVenue(page);
  const r = await page.request.get("/turbo/duel");
  test.skip(r.status() === 404, "/turbo/duel isn't on this branch yet (PR #364)");
  await pass(page, "/turbo/duel?turbo=1");
  // the engine draws the lobby into its own root; it must mount without errors and offer a match
  await expect(page.getByText(/quick match|find a match|play a bot|ranked/i).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
});
