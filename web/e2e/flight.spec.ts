/**
 * Joining a real-coin flight: the coin page opens the flight with the trade bar, the pilot's cash comes from the chain,
 * BOOST with too little cash says so before anything is sent, and the preset keys only select (never trade).
 *
 * The stand-in chain has no real coin behind the address, so this stops short of a filled trade; a full buy/sell needs a
 * forked chain (see e2e/README.md, "Next").
 */
import { test, expect, isPhone } from "./support/fixtures";

const COIN = "0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d";

test("a signed-in pilot with no cash is told before BOOST sends anything", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 0 });
  await page.goto(`/coin/${COIN}`);
  const bar = page.getByTestId("trade-bar").filter({ visible: true }).first();
  await expect(bar).toBeVisible();
  if (!isPhone(page)) await expect(bar).toContainText("Cash $0.00");
  await expect(page.getByText(/Not enough cash: \$10\.00 BOOST, you have \$0\.00/).filter({ visible: true }).first()).toBeVisible();
});

test("the trade bar shows the pilot's cash, and the preset keys only select", async ({ page, pilot }) => {
  test.skip(isPhone(page), "keyboard presets are desktop; phones tap the chips");
  await pilot.signIn({ cash: 50 });
  await page.goto(`/coin/${COIN}`);
  const bar = page.getByTestId("trade-bar");
  await expect(bar).toContainText("Cash $50.00");
  await expect(page.getByTestId("buy-btn")).toHaveText(/BOOST \$10\.00/);
  await page.locator("body").click({ position: { x: 700, y: 300 } }); // focus the flight, not a field
  await page.keyboard.press("Digit3");
  await expect(page.getByTestId("buy-btn")).toHaveText(/BOOST \$50\.00/);
  await page.keyboard.press("KeyC");
  await expect(page.getByTestId("sell-btn")).toHaveText(/DUMP HALF|DUMP 50%/);
});

test("signed out, the flight opens in paper mode with $250 of paper cash", async ({ page }) => {
  await page.goto(`/coin/${COIN}`);
  const bar = page.getByTestId("trade-bar").filter({ visible: true }).first();
  await expect(bar).toBeVisible();
  if (!isPhone(page)) await expect(bar).toContainText(/PAPER\s*Cash \$250\.00/);
});

test("the flight menu has the way back to the lobby", async ({ page, pilot }) => {
  test.skip(isPhone(page), "phones use the phone HUD menu");
  await pilot.signIn({ cash: 5 });
  await page.goto(`/coin/${COIN}`);
  await page.getByTestId("flight-menu-btn").click();
  await expect(page.getByTestId("flight-menu")).toBeVisible();
  await page.getByTestId("flight-menu-lobby").click();
  // leaving shows the flight log first; Leave goes on to the lobby
  const leave = page.getByRole("button", { name: /^leave$/i });
  await expect(leave).toBeVisible();
  await leave.click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
});
