/** Add cash and Cash out (round 2 "Cash" board + Add cash board 2/3, signed off 2026-11-13/14). */
import { test, expect, isPhone } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function openCash(page: Page) {
  await page.getByRole("button", { name: "Your pilot menu" }).filter({ visible: true }).first().click();
  await page.getByTestId("account-menu").getByRole("menuitem", { name: /^cash/i }).click();
  const pop = page.getByTestId("cash-popup");
  await expect(pop).toBeVisible();
  return pop;
}

test("Cash shows the balance, and Add cash quotes a card top-up", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 42.1 });
  await page.goto("/");
  const pop = await openCash(page);
  await expect(pop.getByTestId("cash-balance")).toContainText("$42.10");
  await expect(pop.getByTestId("cash-tab-add")).toHaveAttribute("aria-selected", "true");
  const card = pop.getByTestId("cash-card-fund");
  await expect(card.getByTestId("cash-card-amount")).toHaveText("$25");
  await card.getByRole("button", { name: "$50" }).click();
  await expect(card.getByTestId("cash-card-amount")).toHaveText("$50");
  await expect(card.getByTestId("cash-card-get")).toHaveText("$47.75"); // 4.5% card fee estimate
  // with cash already in, no "Fly in Free play while it lands" nudge
  await expect(card.getByTestId("cash-freeplay")).toHaveCount(0);
});

test("card checkout that can't open says so instead of spinning", async ({ page, pilot }) => {
  // the e2e build has no Privy, so nothing answers the checkout request (same as Privy's chunk being blocked)
  await pilot.signIn({ cash: 0 });
  await page.goto("/");
  const pop = await openCash(page);
  const btn = pop.getByTestId("cash-card-btn");
  await btn.click();
  await expect(btn).toHaveText(/opening checkout/i);
  await expect(pop.getByRole("status")).toContainText("Card checkout isn't available right now", { timeout: 12_000 });
  await expect(btn).toHaveText("Pay with card or Apple Pay");
  // a new player with no cash gets the Free play nudge
  await expect(pop.getByTestId("cash-freeplay")).toBeVisible();
});

test("Send crypto instead shows your own cash address", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 5 });
  await page.goto("/");
  const pop = await openCash(page);
  await pop.getByTestId("cash-send-crypto-btn").click();
  await expect(pop.getByTestId("cash-send-crypto")).toBeVisible();
  // with Privy deposits off only USDG on Robinhood Chain works, straight to the cash address
  await expect(pop.getByTestId("send-address")).toContainText(pilot.address.slice(0, 6));
  await pop.getByTestId("cash-send-back").click();
  await expect(pop.getByTestId("cash-card-fund")).toBeVisible();
});

test("Cash out checks the amount and the address before sending", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 20 });
  await page.goto("/");
  const pop = await openCash(page);
  await pop.getByTestId("cash-tab-out").click();
  await expect(pop.getByText("You have $20.00")).toBeVisible();
  const send = pop.getByTestId("cash-out-btn");
  await expect(send).toBeDisabled();
  await pop.getByRole("button", { name: "Half" }).click();
  await expect(pop.getByTestId("cash-amount")).toHaveValue("10.00");
  await expect(send).toHaveText("Cash out $10.00");
  await pop.getByTestId("cash-to").fill("0x1234");
  await send.click();
  await expect(pop.getByRole("alert")).toHaveText(/doesn't look right/);
  await pop.getByTestId("cash-to").fill("0x000000000000000000000000000000000000dEaD");
  await pop.getByTestId("cash-amount").fill("25");
  await send.click();
  await expect(pop.getByRole("alert")).toHaveText("That's more than you have. You can cash out up to $20.00.");
});

test("a cash out the chain refuses fails in plain words", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 20 });
  await page.goto("/");
  const pop = await openCash(page);
  await pop.getByTestId("cash-tab-out").click();
  await pop.getByTestId("cash-amount").fill("5");
  await pop.getByTestId("cash-to").fill("0x000000000000000000000000000000000000dEaD");
  await pop.getByTestId("cash-out-btn").click();
  const alert = pop.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).not.toHaveText(/relayer|not configured|HTTP|rpc|0x[0-9a-f]{8}|undefined|\[object/i);
  await expect(pop.getByTestId("cash-sent")).toHaveCount(0);
});

test("signed out, Cash asks you to sign in", async ({ page }) => {
  await page.goto("/wallet");
  await expect(page.getByTestId("cash-signed-out")).toBeVisible();
  await expect(page.getByTestId("cash-signed-out").getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("desktop: the top-bar cash chip opens Cash", async ({ page, pilot }) => {
  test.skip(isPhone(page), "the chip is in the desktop top bar");
  await pilot.signIn({ cash: 3.5 });
  await page.goto("/");
  const chip = page.getByTestId("cash-card").filter({ visible: true }).first();
  await expect(chip).toContainText("$3.50");
  await chip.click();
  await expect(page.getByTestId("cash-popup")).toBeVisible();
});
