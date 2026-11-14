/**
 * Screenshot checks for the signed-off screens (@screens). Each one is compared to its baseline in
 * e2e/__screens__/<desktop|phone>/; a change over 2% of the pixels fails the run and the report shows old / new / diff.
 * After a design change that's been signed off, re-take them: `pnpm e2e:update` (then commit the new PNGs).
 *
 * Kept steady: one fixed pilot key, fixed cash, a fixed rocket name on the launch builder, animations off, clocks and
 * other live numbers masked, every image loaded before the shot.
 */
import { test, expect, setCash, settle, isPhone, OWNER_KEY } from "./support/fixtures";
import { fakeVenue } from "./support/venue";
import type { Locator, Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const KEY = ("0x" + "5e".repeat(32)) as `0x${string}`;
const ADDRESS = privateKeyToAccount(KEY).address;

async function signIn(page: Page, cash = 125.5) {
  await setCash(ADDRESS, cash);
  await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); localStorage.setItem("disciple.welcomed.v1", "1"); } catch { /* */ } }, [OWNER_KEY, KEY] as const);
}

/** wait for every <img> on the page and the web fonts, then let layout settle */
async function ready(page: Page) {
  await settle(page);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 15_000 }).catch(() => {});
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important} [data-testid=welcome-toast]{display:none!important}" });
  await page.waitForTimeout(300);
}

/** live numbers that change minute to minute */
const live = (page: Page): Locator[] => [
  page.locator(".xp-reset"), page.locator("[class*=meta]").filter({ hasText: /New in/ }), page.getByText(/NEW FLIGHT IN/), page.getByTestId("so-ticker"),
];

const shot = async (page: Page, name: string, o: { full?: boolean; mask?: Locator[]; target?: Locator } = {}) => {
  await ready(page);
  const opt = { mask: [...live(page), ...(o.mask ?? [])], fullPage: o.full ?? false };
  if (o.target) await expect(o.target).toHaveScreenshot(`${name}.png`, opt);
  else await expect(page).toHaveScreenshot(`${name}.png`, opt);
};

test.describe("@screens signed-off screens", () => {
  test("lobby, signed out (Pick a mode)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("lobby-signed-out")).toBeVisible();
    await page.waitForTimeout(6_500); // HomeGate settles (local signer gives up on Privy after 6 s) and unmounts the other lobby
    await shot(page, "lobby-signed-out");
  });

  test("lobby, signed in", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    await expect(page.getByTestId("lobby")).toBeVisible();
    await page.waitForTimeout(6_500);
    await shot(page, "lobby-signed-in");
  });

  test("Free play hub", async ({ page }) => {
    await page.goto("/flight/sim");
    await expect(page.getByTestId("sim-select")).toBeVisible();
    await shot(page, "free-play-hub", { mask: [page.getByLabel(/^Daily flight #/).locator("h2, [class*=num]")] });
  });

  test("Cash popup, Add cash", async ({ page }) => {
    await signIn(page);
    await page.goto("/wallet");
    await expect(page.getByTestId("cash-balance")).toContainText("$125.50");
    await shot(page, "cash-add");
  });

  test("Cash popup, Cash out", async ({ page }) => {
    await signIn(page);
    await page.goto("/wallet");
    await page.getByTestId("cash-tab-out").click();
    await shot(page, "cash-out");
  });

  test("Settings popup", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");
    const m = page.getByTestId("settings-modal");
    await expect(m).toBeVisible();
    await shot(page, "settings", { target: m });
  });

  test("Rewards popup", async ({ page }) => {
    await signIn(page);
    await page.goto("/profile#rewards");
    const m = page.getByTestId("rewards-popup");
    await expect(m).toBeVisible();
    await expect(m.getByTestId("rewards-total-usd").last()).toHaveText("$0.00", { timeout: 20_000 });
    await shot(page, "rewards", { target: m, mask: [m.getByTestId("referral-link")] });
  });

  test("Hangar, signed out", async ({ page }) => {
    await page.goto("/profile");
    await expect(page.getByText(/this bay/i).first()).toBeVisible();
    await shot(page, "hangar-signed-out");
  });

  test("launch builder", async ({ page }) => {
    await signIn(page);
    await page.goto("/create");
    await page.getByRole("textbox", { name: /name/i }).first().fill("E2E Comet");
    await page.getByRole("textbox", { name: /ticker|call sign/i }).first().fill("COMET").catch(() => {});
    await shot(page, "launch-builder");
  });

  test("Missions + trophies", async ({ page }) => {
    await signIn(page);
    await page.goto("/achievements");
    await shot(page, "trophies");
  });

  test("Top pilots", async ({ page }) => {
    await page.goto("/leaderboard");
    await shot(page, "top-pilots");
  });

  test("How to play", async ({ page }) => {
    await page.goto("/how-it-works");
    await shot(page, "how-to-play");
  });

  test("docs article", async ({ page }) => {
    await page.goto("/docs");
    await shot(page, "docs-home");
  });

  test("404", async ({ page }) => {
    await page.goto("/no-such-page");
    await shot(page, "not-found");
  });

  test("Turbo ready screen", async ({ page }) => {
    await signIn(page);
    await fakeVenue(page, { drift: 0 });
    await page.goto("/turbo?sample=1");
    const gate = page.getByTestId("turbo-gate");
    if (await gate.isVisible().catch(() => false)) { await page.getByTestId("turbo-gate-input").fill("e2e-turbo"); await page.getByTestId("turbo-gate-go").click(); }
    await expect(page.getByTestId("turbo-ready")).toBeVisible();
    await shot(page, "turbo-ready", { mask: [page.getByTestId("turbo-tape"), page.locator("canvas")] });
  });

  test("phone: lobby tab bar", async ({ page }) => {
    test.skip(!isPhone(page), "phone only");
    await signIn(page);
    await page.goto("/");
    await page.waitForTimeout(6_500);
    await shot(page, "phone-tabbar", { target: page.locator("nav").last() });
  });
});
