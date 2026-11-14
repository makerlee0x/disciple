/** First visit: the signed-out lobby is the landing page, and "Pick a mode" is the first thing on it. */
import { test, expect, isPhone, hydrated } from "./support/fixtures";
import type { Page } from "@playwright/test";

/** the landing lobby (HomeGate keeps both lobbies mounted until sign-in state settles, so scope to this one) */
const out = (page: Page) => page.getByTestId("lobby-signed-out");

test.describe("first visit", () => {
  test("lobby opens on Pick a mode with Free play in focus", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("lobby-signed-out")).toBeVisible();
    const modes = out(page).getByTestId("mode-select");
    await expect(modes.getByRole("heading", { name: "Pick a mode" })).toBeVisible();
    for (const id of ["launch", "live", "free"]) await expect(out(page).getByTestId(`mode-${id}`)).toBeAttached();
    // signed out it opens on Free play
    await expect(out(page).getByTestId("mode-free")).toHaveAttribute("aria-current", "true");
    // Trading duel stays hidden until the Turbo flag is on
    await expect(out(page).getByTestId("mode-duel")).toHaveCount(0);
  });

  test("the top bar has Lobby, Launch and Top pilots", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByTestId("lobby-topbar");
    await expect(bar).toBeVisible();
    if (isPhone(page)) return; // phones use the bottom tab bar (see below)
    for (const name of [/lobby/i, /launch/i, /top pilots/i]) await expect(bar.getByRole("link", { name }).first()).toBeVisible();
  });

  test("desktop: first click focuses a card, the second plays it", async ({ page }) => {
    test.skip(isPhone(page), "phones tap straight through (next test)");
    await page.goto("/");
    const live = out(page).getByTestId("mode-live");
    await hydrated(live);
    await live.click();
    await expect(live).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(/\/$/);
    await live.click();
    // nothing is flying on the stand-in chain, so /play falls back to the launch builder
    await expect(page).toHaveURL(/\/(create|coin\/)/);
  });

  test("desktop: arrow keys move focus and Enter plays", async ({ page }) => {
    test.skip(isPhone(page), "keyboard row is desktop only");
    await page.goto("/");
    await hydrated(out(page).getByTestId("mode-free"));
    await out(page).getByTestId("mode-free").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(out(page).getByTestId("mode-live")).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(out(page).getByTestId("mode-launch")).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowLeft"); // wraps round
    await expect(out(page).getByTestId("mode-free")).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/flight\/sim/);
  });

  test("phone: tapping a card goes straight to it", async ({ page }) => {
    test.skip(!isPhone(page), "phone only");
    await page.goto("/");
    await out(page).getByTestId("mode-free").tap();
    await expect(page).toHaveURL(/\/flight\/sim/);
    await expect(page.getByTestId("sim-select")).toBeVisible();
  });

  test("the Trading duel card shows once the Turbo flag is on", async ({ page }) => {
    await page.goto("/?turbo=1");
    await expect(out(page).getByTestId("mode-duel")).toBeAttached();
    await expect(out(page).getByTestId("mode-duel")).toHaveAttribute("href", /\/turbo\/duel/);
  });

  test("the help button opens How to play and Docs", async ({ page }) => {
    test.skip(isPhone(page), "the ? button is desktop only");
    await page.goto("/");
    await page.getByTestId("topbar-help").click();
    const card = page.getByTestId("help-card");
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: /how to play/i })).toBeVisible();
    await expect(card.getByRole("link", { name: /docs/i })).toBeVisible();
  });

  test("How it plays sits under the modes", async ({ page }) => {
    await page.goto("/");
    await expect(out(page).getByRole("heading", { name: /boost it up/i })).toBeVisible();
    // nothing is flying on the stand-in chain, so the live ticker and Top pilots (real cash-outs only) stay hidden
    await expect(out(page).getByTestId("so-ticker")).toHaveCount(0);
  });
});
