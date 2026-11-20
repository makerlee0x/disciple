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
    // Launch, Duel, Climb, Daily mission (maker 2026-11-18). Live flights is a top bar tab, not a card. Royale is held for launch.
    for (const id of ["launch", "duel", "climb", "daily"]) await expect(out(page).getByTestId(`mode-${id}`)).toBeAttached();
    for (const id of ["live", "free", "royale"]) await expect(out(page).getByTestId(`mode-${id}`)).toHaveCount(0);
    await expect(out(page).getByTestId("mode-launch")).toContainText("Your own coin");
    await expect(out(page).getByTestId("mode-duel")).toContainText("1v1");
    await expect(out(page).getByTestId("mode-climb")).toContainText("Solo");
    await expect(out(page).getByTestId("mode-daily")).toContainText("Solo");
  });

  test("the top bar has Turbo, Leaderboard and Launch now (to the launch flow), no Launch tab or Live flights (the mark is the lobby)", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByTestId("lobby-topbar");
    await expect(bar).toBeVisible();
    if (isPhone(page)) return; // phones use the bottom tab bar (see below)
    for (const name of [/leaderboard/i, /launch now/i]) await expect(bar.getByRole("link", { name }).first()).toBeVisible();
    await expect(bar.getByTestId("topbar-launch")).toHaveAttribute("href", "/create");
    await expect(bar.getByTestId("topbar-launch")).toHaveText(/launch now/i);
    await expect(bar.locator(".lb-top").getByRole("link", { name: /^launch$/i })).toBeHidden();
    await expect(bar.locator(".lb-top").getByRole("link", { name: /live flights/i })).toHaveCount(0);
    await expect(bar.getByRole("link", { name: /^lobby$/i })).toHaveCount(0);
    // Turbo is on for everyone
    await expect(bar.getByTestId("nav-turbo").first()).toBeVisible();
  });

  test("Turbo tab opens a menu with Duel and Climb", async ({ page }) => {
    await page.goto("/");
    const tab = page.locator(isPhone(page) ? ".lb-dock [data-testid=nav-turbo]" : ".lb-top [data-testid=nav-turbo]").first();
    await hydrated(tab);
    await tab.click();
    const menu = page.getByTestId("turbo-menu");
    await expect(menu.getByRole("menuitem", { name: /duel/i })).toHaveAttribute("href", /\/turbo\/duel/);
    await expect(menu.getByRole("menuitem", { name: /climb/i })).toHaveAttribute("href", /\/turbo\/climb/);
    await expect(menu.getByRole("menuitem", { name: /royale/i })).toHaveCount(0);
  });

  test("Live flights opens every rocket", async ({ page }) => {
    await page.goto("/live");
    await expect(page.getByRole("heading", { name: /live flights/i })).toBeVisible();
  });

  test("one click on any card opens it", async ({ page }) => {
    test.skip(isPhone(page), "phones: see the tap test below");
    await page.goto("/");
    const duel = out(page).getByTestId("mode-duel");
    await hydrated(duel);
    await duel.click();
    await expect(page).toHaveURL(/\/turbo\/duel/);
  });

  test("desktop: arrow keys move between cards and Enter plays", async ({ page }) => {
    test.skip(isPhone(page), "keyboard row is desktop only");
    await page.goto("/");
    await hydrated(out(page).getByTestId("mode-daily"));
    await out(page).getByTestId("mode-daily").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(out(page).getByTestId("mode-climb")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // wraps round
    await expect(out(page).getByTestId("mode-launch")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(out(page).getByTestId("mode-daily")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/flight\/sim\?daily=1/);
  });

  test("phone: one tap on a card opens it, even one at the side", async ({ page }) => {
    test.skip(!isPhone(page), "phone only");
    await page.goto("/");
    const duel = out(page).getByTestId("mode-duel");
    await hydrated(duel);
    await duel.tap({ position: { x: 20, y: 120 } });
    await expect(page).toHaveURL(/\/turbo\/duel/);
  });

  test("the Duel card opens its mode", async ({ page }) => {
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
