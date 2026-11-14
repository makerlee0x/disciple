/** Settings popup v2 (signed off 2026-11-14): open from the pilot menu, change things, they stick. */
import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Your pilot menu" }).filter({ visible: true }).first().click();
  await page.getByTestId("account-menu").getByRole("menuitem", { name: /settings/i }).click();
  const m = page.getByTestId("settings-modal");
  await expect(m).toBeVisible();
  return m;
}

test("settings: max price move, bombs, vibration and Turbo leave all stick after a reload", async ({ page, pilot }) => {
  await pilot.signIn();
  await page.goto("/");
  let m = await openSettings(page);
  await expect(m.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(m.getByTestId("settings-wallet")).toContainText(pilot.address.slice(0, 6));

  const slips = m.getByTestId("onetap-slippage").getByRole("radio");
  const n = await slips.count(); expect(n).toBeGreaterThan(1);
  const pick = slips.nth(n - 1), pickId = await pick.getAttribute("data-testid");
  await pick.click();
  await expect(pick).toHaveAttribute("aria-checked", "true");

  const bombs = m.getByTestId("settings-bombs"), bombsWas = await bombs.getAttribute("aria-checked");
  await bombs.click();
  await expect(bombs).not.toHaveAttribute("aria-checked", bombsWas!);
  const hap = m.getByTestId("settings-haptics"), hapWas = await hap.getAttribute("aria-checked");
  await hap.click();
  await expect(hap).not.toHaveAttribute("aria-checked", hapWas!);
  const leave = m.getByTestId("settings-turbo-leave").getByRole("radio");
  await leave.last().click();
  const leaveId = await leave.last().getAttribute("data-testid");

  await page.keyboard.press("Escape");
  await expect(m).toBeHidden();
  await page.reload();
  m = await openSettings(page);
  await expect(m.getByTestId(pickId!)).toHaveAttribute("aria-checked", "true");
  await expect(m.getByTestId("settings-bombs")).not.toHaveAttribute("aria-checked", bombsWas!);
  await expect(m.getByTestId("settings-haptics")).not.toHaveAttribute("aria-checked", hapWas!);
  await expect(m.getByTestId(leaveId!)).toHaveAttribute("aria-checked", "true");
});

test("settings: the 2-step check page opens and comes back", async ({ page, pilot }) => {
  await pilot.signIn();
  await page.goto("/");
  const m = await openSettings(page);
  await m.getByTestId("settings-2fa").click();
  await expect(m.getByTestId("twofa-view")).toBeVisible();
  await m.getByTestId("twofa-back").click();
  await expect(m.getByTestId("settings-security")).toBeVisible();
});

test("settings: sign out from the footer", async ({ page, pilot }) => {
  await pilot.signIn();
  await page.goto("/");
  const m = await openSettings(page);
  await m.getByTestId("settings-signout").click();
  await expect(m).toBeHidden();
  await expect(page.getByRole("button", { name: /^sign in$/i }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Your pilot menu" })).toHaveCount(0);
});

test("the /settings link opens the same popup", async ({ page, pilot }) => {
  await pilot.signIn();
  await page.goto("/settings");
  await expect(page.getByTestId("settings-modal")).toBeVisible();
});
