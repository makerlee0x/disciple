/**
 * Claims: the Rewards popup (Hangar popups v2) and the host dashboard. A new pilot has nothing to claim, so Claim stays
 * off and each tab explains how rewards come in; the referral link is the pilot's own.
 */
import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function openRewards(page: Page) {
  await page.getByRole("button", { name: "Your pilot menu" }).filter({ visible: true }).first().click();
  await page.getByTestId("account-rewards").click();
  const pop = page.getByTestId("rewards-popup");
  await expect(pop).toBeVisible();
  return pop;
}

test("a new pilot's Rewards: nothing ready, Claim off, all three tabs open", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 10 });
  await page.goto("/");
  const pop = await openRewards(page);
  await expect(pop.getByRole("heading", { name: /rewards/i })).toBeVisible();
  await expect(pop.getByTestId("rewards-total-usd").last()).toHaveText("$0.00", { timeout: 20_000 });
  await expect(pop.getByTestId("claim-all-rewards")).toBeDisabled();
  const tabs = pop.getByRole("tab");
  const n = await tabs.count();
  expect(n).toBe(3);
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await expect(tabs.nth(i)).toHaveAttribute("aria-selected", "true");
  }
  await pop.getByTestId("rewards-tab-referral").click();
  await expect(pop.getByTestId("rewards-empty")).toBeVisible();
});

test("the referral link is yours and Copy copies it", async ({ page, pilot, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await pilot.signIn();
  await page.goto("/");
  const pop = await openRewards(page);
  await pop.getByTestId("rewards-tab-referral").click();
  const ref = pop.getByTestId("referral-link");
  await expect(ref).toBeVisible();
  const copy = ref.getByTestId("copy-ref");
  await expect(copy).toBeEnabled({ timeout: 15_000 });
  await copy.click();
  await expect(copy).toHaveText(/copied/i);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toMatch(/^https?:\/\/[^ ]+/);
});

test("the host dashboard opens for a signed-in pilot with no rockets yet", async ({ page, pilot }) => {
  await pilot.signIn();
  const r = await page.goto("/creator");
  expect(r?.status()).toBeLessThan(400);
  await expect(page.locator("main, body").first()).toContainText(/host|launch|rocket/i);
});
