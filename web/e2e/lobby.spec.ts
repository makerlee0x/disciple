/** First visit: the signed-out lobby is the landing page. With a rocket in the air the climbing hero leads (BOOST, Launch yours) and "Pick a mode" follows; with none, Pick a mode leads. */
import { test, expect, isPhone, hydrated } from "./support/fixtures";
import type { Page } from "@playwright/test";

/** the landing lobby (HomeGate keeps both lobbies mounted until sign-in state settles, so scope to this one) */
const out = (page: Page) => page.getByTestId("lobby-signed-out");

test.describe("first visit", () => {
  test("lobby opens on Pick a mode as a carousel", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("lobby-signed-out")).toBeVisible();
    const modes = out(page).getByTestId("mode-select");
    await expect(modes.getByRole("heading", { name: "Pick a mode" })).toBeVisible();
    for (const id of ["launch", "live", "free"]) await expect(out(page).getByTestId(`mode-${id}`)).toBeAttached();
    // Turbo is on for everyone: Trading duel is in the row. Turbo royale is held for launch (lib/features ROYALE_ENABLED)
    await expect(out(page).getByTestId("mode-duel")).toBeAttached();
    await expect(out(page).getByTestId("mode-royale")).toHaveCount(0);
  });

  test("the top bar has Live flights, Launch, Top pilots and Play now (the mark is the lobby)", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByTestId("lobby-topbar");
    await expect(bar).toBeVisible();
    if (isPhone(page)) return; // phones use the bottom tab bar (see below)
    for (const name of [/live flights/i, /launch/i, /top pilots/i, /play now/i]) await expect(bar.getByRole("link", { name }).first()).toBeVisible();
    await expect(bar.getByRole("link", { name: /^lobby$/i })).toHaveCount(0);
    // Turbo is on for everyone
    await expect(bar.getByTestId("nav-turbo").first()).toBeVisible();
  });

  test("Turbo tab goes straight to Trading duel while Royale is held", async ({ page }) => {
    await page.goto("/");
    const tab = page.locator(isPhone(page) ? ".lb-dock [data-testid=nav-turbo]" : ".lb-top [data-testid=nav-turbo]").first();
    await expect(tab).toHaveAttribute("href", /\/turbo\/duel/);
    await expect(page.getByTestId("turbo-menu")).toHaveCount(0);
  });

  test("Live flights opens every rocket", async ({ page }) => {
    await page.goto("/live");
    await expect(page.getByRole("heading", { name: /live flights/i })).toBeVisible();
  });

  test("one click on any card opens it", async ({ page }) => {
    test.skip(isPhone(page), "phones: see the tap test below");
    await page.goto("/");
    const live = out(page).getByTestId("mode-live");
    await hydrated(live);
    await live.click();
    // Live flights opens the list of every rocket, not one random rocket
    await expect(page).toHaveURL(/\/live$/);
  });

  test("desktop: arrow keys move between cards and Enter plays", async ({ page }) => {
    test.skip(isPhone(page), "keyboard row is desktop only");
    await page.goto("/");
    await hydrated(out(page).getByTestId("mode-free"));
    await out(page).getByTestId("mode-free").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(out(page).getByTestId("mode-duel")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // wraps round
    await expect(out(page).getByTestId("mode-launch")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(out(page).getByTestId("mode-free")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/flight\/sim/);
  });

  test("phone: one tap on a card opens it, even one at the side", async ({ page }) => {
    test.skip(!isPhone(page), "phone only");
    await page.goto("/");
    const live = out(page).getByTestId("mode-live");
    await hydrated(live);
    await live.tap({ position: { x: 20, y: 120 } });
    await expect(page).toHaveURL(/\/live$/);
  });

  test("the Trading duel card opens its mode", async ({ page }) => {
    await page.goto("/");
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

test.describe("brand-new visitor", () => {
  test.use({ firstVisit: true });

  test("the first visit opens the welcome screen, Play starts a free bot duel, and later visits go to the lobby", async ({ page }) => {
    await page.goto("/");
    const wi = page.getByTestId("welcome-intro");
    await expect(wi).toBeVisible();
    await hydrated(page.getByTestId("welcome-play"));
    await page.getByTestId("welcome-play").click();
    await expect(page).toHaveURL(/\/turbo\/duel/);
    await expect(page.getByTestId("turbo-gate")).toHaveCount(0);
    await page.goto("/");
    await expect(out(page)).toBeVisible();
    await expect(page.getByTestId("welcome-intro")).toHaveCount(0);
  });

  test("a shared link on a first visit goes where it points, with no welcome screen", async ({ page }) => {
    await page.goto("/how-it-works");
    await page.waitForLoadState("load");
    await expect(page.getByTestId("welcome-intro")).toHaveCount(0);
  });
});
