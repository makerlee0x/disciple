/**
 * Free play: the hub, a practice run with BOOST and DUMP, Trade settings in flight, and today's Daily flight scored by
 * the real server (start ticket → 2-minute flight → POST /api/daily re-flies the input log → rank).
 */
import { test, expect, isPhone } from "./support/fixtures";
import type { Page } from "@playwright/test";

// phones fly with the throttle lever (a drag), which the engine reads the same way as SPACE / SHIFT, so both sizes use the keys
const boost = (page: Page) => page.keyboard.press("Space");
const dump = (page: Page) => page.keyboard.press("Shift");
/** phones: the first flight opens with the How to fly card; FLY closes it */
async function pastIntro(page: Page) {
  if (!isPhone(page)) return;
  const go = page.getByTestId("fr-go");
  await go.waitFor({ state: "visible", timeout: 8_000 }).then(() => go.tap()).catch(() => {});
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

test("the Free play hub shows today's daily and the three practice levels", async ({ page }) => {
  await page.goto("/flight/sim");
  const hub = page.getByTestId("sim-select");
  await expect(hub.getByRole("heading", { name: "FREE PLAY" })).toBeVisible();
  await expect(hub.getByTestId("sim-daily")).toHaveText("FLY TODAY'S FLIGHT");
  for (const d of ["pve", "pvp", "trench"]) await expect(hub.getByTestId(`sim-diff-${d}`)).toBeVisible();
  await expect(hub.getByLabel(/^Daily flight #\d+$/)).toBeVisible();
});

test("practice run: boost buys a seat, dump cashes it out, the run ends on a result", async ({ page }) => {
  await page.goto("/flight/sim?speed=4&minutes=1");
  await page.getByTestId("sim-diff-pve").click();
  await pastIntro(page);
  await expectRun(page, /PRACTICE/);
  await expect(page.getByTestId("trade-bar")).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __flight?: { assetsReady?: () => boolean } }).__flight?.assetsReady?.() === true, null, { timeout: 20_000 });

  await boost(page);
  await expect.poll(async () => (await runState(page)).tokens, { message: "BOOST bought tokens", timeout: 10_000 }).toBeGreaterThan(0);
  // DUMP sells the selected size: pick 100% (sell key V) so the seat is fully cashed out
  await page.keyboard.press("KeyV");
  await dump(page);
  await expect.poll(async () => (await runState(page)).tokens, { message: "DUMP sold the seat", timeout: 10_000 }).toBeLessThan(1e-6);

  const result = page.getByTestId("sim-summary");
  await expect(result).toBeVisible({ timeout: 40_000 });
  await expect(result.getByRole("dialog", { name: "Practice result" })).toBeVisible();
  await expect(result.getByTestId("sim-xp")).toHaveText("Sign in to earn XP from Free play.");
  await result.getByRole("button", { name: "FREE PLAY" }).click();
  await expect(page.getByTestId("sim-select")).toBeVisible();
  // the level's best is kept on this browser
  await expect(page.getByTestId("sim-diff-pve")).toHaveAttribute("aria-label", /best /);
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
  await page.goto("/flight/sim?minutes=5");
  await page.getByTestId("sim-diff-pve").click();
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
  await page.goto("/flight/sim?minutes=5");
  await page.getByTestId("sim-diff-pve").click();
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
  await pastIntro(page);
  await expectRun(page, /DAILY #\d+/);
  await page.waitForFunction(() => (window as unknown as { __flight?: { assetsReady?: () => boolean } }).__flight?.assetsReady?.() === true, null, { timeout: 20_000 });
  await page.waitForTimeout(3_000);
  await boost(page);
  await expect.poll(async () => (await runState(page)).tokens, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(20_000);
  await dump(page);

  // the daily is two minutes at 1×; the server won't score a faster one
  const res = page.getByTestId("daily-result");
  await expect(res).toBeVisible({ timeout: 150_000 });
  // signed out the score is checked but not boarded: "Would place #N of M today"
  const rank = res.getByTestId("daily-rank-pending");
  await expect(rank).toBeVisible({ timeout: 20_000 });
  await expect(rank).toHaveText(/Would place #\d+ of \d+ today/);
  await expect(res.getByTestId("daily-rank-error")).toHaveCount(0);
  await expect(res.getByTestId("daily-multiple")).toHaveText(/\d+(\.\d+)?×/);

  // one scored run per device a day: the hub now offers the result, not a second flight
  await res.getByTestId("daily-close").click();
  await expect(page.getByTestId("sim-daily")).toHaveText("SEE YOUR RESULT");
  await page.reload();
  await expect(page.getByTestId("sim-daily")).toHaveText("SEE YOUR RESULT");
  await page.getByTestId("sim-daily").click();
  await expect(page.getByTestId("daily-result").getByTestId("daily-rank-pending")).toHaveText(/Would place #\d+ of \d+ today/);
});

test("the daily board refuses a run that skipped the start ticket", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "server check, once is enough");
  const today = (await (await request.get("/api/daily")).json()).id as number;
  const r = await request.post("/api/daily", { headers: { origin: "http://127.0.0.1:3210", "sec-fetch-site": "same-origin" }, data: { id: today, device: "e2e-device-0000000000", inputs: [], ticket: "" } });
  expect(r.status()).toBe(403);
  expect((await r.json()).error).toMatch(/start the flight from the game/i);
});
