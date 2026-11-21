/**
 * Free play: the hub, a practice run with BOOST and DUMP, Trade settings in flight, and today's Daily flight scored by
 * the real server (start ticket → 2-minute flight → POST /api/daily re-flies the input log → rank).
 */
import { test, expect, isPhone } from "./support/fixtures";
import type { Page } from "@playwright/test";

// phones fly with the throttle lever (a drag), which the engine reads the same way as SPACE / SHIFT, so both sizes use the keys
const boost = (page: Page) => page.keyboard.press("Space");
/** Free play: ENTER cashes the whole bag out (SHIFT sells half) */
const dump = (page: Page) => page.keyboard.press("Enter");
/** phones: the first flight used to open with a How to fly card; it's a finger on the lever now (nothing to close) */
async function pastIntro(page: Page) {
  if (!isPhone(page)) return;
  await expect(page.getByTestId("fr-go")).toHaveCount(0);
}
/** the run strip on desktop, the folded run chip on phones */
async function expectRun(page: Page, mode: RegExp) {
  if (isPhone(page)) await expect(page.getByTestId("sim-chip").or(page.getByTestId("sim-bar")).first()).toHaveAttribute("aria-label", mode);
  else await expect(page.getByTestId("sim-bar")).toContainText(mode);
}
/** the run's own ledger (lib/sim/run): tokens held and every input the player made */
const runState = (page: Page) => page.evaluate(() => {
  const S = (window as unknown as { __flight?: { S?: { hold?: { tokens?: number; valueUsd?: number } } } }).__flight?.S;
  return { tokens: S?.hold?.tokens ?? 0, value: S?.hold?.valueUsd ?? 0 };
});

test("the Free play hub shows today's daily and its board, with no practice levels", async ({ page }) => {
  await page.goto("/flight/sim");
  const hub = page.getByTestId("sim-select");
  await expect(hub.getByRole("heading", { name: "DAILY MISSION" })).toBeVisible();
  await expect(hub.getByTestId("sim-daily")).toHaveText("FLY TODAY'S FLIGHT");
  // practice was removed (maker 2026-11-16): the daily is the whole mode
  for (const d of ["pve", "pvp", "trench"]) await expect(hub.getByTestId(`sim-diff-${d}`)).toHaveCount(0);
  const daily = hub.getByLabel(/^Daily flight #\d+$/);
  await expect(daily).toBeVisible();
  // one level for everyone: no difficulty on the daily
  await expect(daily).not.toContainText(/\b(EASY|HARD|EXPERT)\b/);
  // today's board shows on phones too
  await expect(hub.getByLabel("Today's board")).toBeVisible();
});

test("Trade settings open from the flight, and new boost amounts stick and show on the trade bar", async ({ page }) => {
  test.skip(isPhone(page), "phones get the lever's Boost amounts sheet (next test)");
  const open = async () => {
    if (isPhone(page)) await page.getByTestId("phone-gear").filter({ visible: true }).first().tap();
    else { await page.getByTestId("flight-menu-btn").click(); await page.getByTestId("flight-menu-trade").click(); }
    const box = page.getByTestId("swap-settings");
    await expect(box).toBeVisible();
    return box;
  };
  await page.goto("/flight/sim?minutes=5&autostart=1");
  await pastIntro(page);
  await expect(page.getByTestId("trade-bar").filter({ visible: true }).first()).toBeVisible();
  let box = await open();
  await expect(box.getByRole("heading", { name: /trade settings/i })).toBeVisible();
  // Free play: price protection only applies to real flights, so no max-move choices here
  await expect(box.getByTestId("swap-slip")).toHaveCount(0);
  await expect(box.getByTestId("swap-autoscale")).toHaveAttribute("aria-checked", "true");
  // like a player: tap the field (it switches to your own amounts and selects the number), then type
  await box.getByTestId("swap-buy-0").click();
  await page.keyboard.type("15");
  await expect(box.getByTestId("swap-buy-0")).toHaveValue("15");
  await expect(box.getByTestId("swap-autoscale")).toHaveAttribute("aria-checked", "false");
  // under the minimum is refused in plain words
  await box.getByTestId("swap-buy-1").fill("1");
  await box.getByTestId("swap-save").click();
  await expect(box.getByTestId("swap-buy-note")).toHaveText(/at least \$\d+/);
  await box.getByTestId("swap-buy-1").fill("30");
  await box.getByTestId("swap-save").click();
  await expect(box).toBeHidden();
  await expect(page.getByTestId("boost-chip-0").filter({ visible: true }).first()).toContainText("$15");
  box = await open();
  await expect(box.getByTestId("swap-buy-0")).toHaveValue("15");
  await expect(box.getByTestId("swap-buy-1")).toHaveValue("30");
});

test("phone: the gear opens Boost amounts for the lever, with sound and vibration", async ({ page }) => {
  test.skip(!isPhone(page), "phone only");
  await page.goto("/flight/sim?minutes=5&autostart=1");
  await pastIntro(page);
  await page.getByTestId("phone-gear").filter({ visible: true }).first().tap();
  await expect(page.getByText("BOOST AMOUNTS", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/four notches on your lever/i)).toBeVisible();
  for (const name of [/sound effects/i, /music/i, /vibration/i]) await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^done$/i }).tap();
  await expect(page.getByText(/four notches on your lever/i)).toBeHidden();
});

test("Daily flight: fly it, get scored by the server, and see the same result next time", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  await page.goto("/flight/sim");
  await page.getByTestId("sim-daily").click();
  // the pre-flight screen: today's board and the controls, nothing flying until LAUNCH and the countdown
  const pre = page.getByTestId("daily-pre");
  await expect(pre).toBeVisible();
  await expect(pre.getByTestId("daily-pre-board")).toBeVisible();
  await expect(pre).not.toContainText(/\b(EASY|HARD|EXPERT)\b/);
  await expect(page.getByTestId("sim-bar").or(page.getByTestId("sim-chip"))).toHaveCount(0);
  await pre.getByTestId("daily-launch").click();
  await expect(page.getByTestId("fp-countdown")).toBeVisible();
  await pastIntro(page);
  await expectRun(page, /DAILY #\d+/);
  // the daily's buys are % of cash (cash grows with PnL), not the player's $ presets
  await expect(page.locator('[data-testid="boost-chip-0"], [data-testid="thr-buy-0"]').first()).toHaveText(/^10%/);
  await expect(page.locator('[data-testid="boost-chip-3"], [data-testid="thr-buy-3"]').first()).toHaveText(/^ALL/);
  await page.waitForFunction(() => (window as unknown as { __flight?: { assetsReady?: () => boolean } }).__flight?.assetsReady?.() === true, null, { timeout: 20_000 });
  await page.waitForTimeout(3_000);
  await boost(page);
  await expect.poll(async () => (await runState(page)).tokens, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(20_000);
  await dump(page);
  await expect.poll(async () => (await runState(page)).tokens, { timeout: 10_000 }).toBe(0);
  // the cash-out is the score: BANKED is a big tile on desktop, the phone bag card turns into CASHED OUT
  if (isPhone(page)) await expect(page.getByTestId("phone-bag")).toHaveAttribute("data-cashed", "1");
  else await expect(page.getByTestId("pnl-banked")).toContainText(/[+\-−]\$\d/);

  // the daily is 80 s (its 2-minute market at 1.5×); the server won't score a faster one
  const res = page.getByTestId("daily-result");
  await expect(res).toBeVisible({ timeout: 110_000 });
  // signed out the score is checked but not boarded: "Would place #N of M today"
  const rank = res.getByTestId("daily-rank-pending");
  await expect(rank).toBeVisible({ timeout: 20_000 });
  await expect(rank).toHaveText(/Would place #\d+ of \d+ today/);
  await expect(res.getByTestId("daily-rank-error")).toHaveCount(0);
  await expect(res.getByTestId("daily-pnl")).toHaveText(/^[+−]\$[\d,]+$/);
  await expect(res.getByTestId("daily-result-board")).toBeVisible();

  // one scored run per device a day: the fly button goes and the hub board shows your run instead (components/sim/FreePlay)
  await res.getByTestId("daily-close").click();
  await expect(page.getByTestId("sim-daily")).toHaveCount(0);
  await expect(page.getByTestId("daily-hub-board")).toContainText(/Your rank/i);
  await page.reload();
  await expect(page.getByTestId("daily-hub-board")).toContainText(/Your rank/i);
  await expect(page.getByTestId("sim-daily")).toHaveCount(0);
});

test("the daily board refuses a run that skipped the start ticket", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "server check, once is enough");
  const today = (await (await request.get("/api/daily")).json()).id as number;
  const r = await request.post("/api/daily", { headers: { origin: "http://127.0.0.1:3210", "sec-fetch-site": "same-origin" }, data: { id: today, device: "e2e-device-0000000000", inputs: [], ticket: "" } });
  expect(r.status()).toBe(403);
  expect((await r.json()).error).toMatch(/start the flight from the game/i);
});
