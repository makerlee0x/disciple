/**
 * Sign-in. The e2e build uses the local signer (NEXT_PUBLIC_AA_SIGNER=local): "Sign in" makes a key on this browser
 * instead of opening Privy, so everything after the Privy window is the real flow (account chip, welcome toast,
 * account menu, sign out).
 */
import { test, expect, isPhone } from "./support/fixtures";

test("sign in from the lobby, see the welcome toast and the pilot chip, then sign out", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("lobby-signed-out")).toBeVisible();
  const signIn = page.getByRole("button", { name: /^sign in$/i }).filter({ visible: true }).first();
  await signIn.click();
  await expect(page.getByRole("button", { name: "Your pilot menu" }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("welcome-toast")).toBeVisible();
  await expect(page.getByTestId("welcome-toast")).toContainText("You're in, pilot");
  // the signed-in lobby replaces the landing page
  await expect(page.getByTestId("lobby")).toBeVisible();
  await expect(page.getByTestId("lobby-signed-out")).toHaveCount(0);
  // signed in, Pick a mode opens on Live flights
  await expect(page.getByTestId("mode-live")).toHaveAttribute("aria-current", "true");

  // the key survives a reload (same pilot, no second welcome)
  await page.reload();
  await expect(page.getByRole("button", { name: "Your pilot menu" }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("welcome-toast")).toHaveCount(0);

  await page.getByRole("button", { name: "Your pilot menu" }).filter({ visible: true }).first().click();
  const menu = page.getByTestId("account-menu");
  await expect(menu).toBeVisible();
  for (const name of [/hangar/i, /missions \+ trophies/i, /cash/i, /rewards/i, /settings/i]) await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  await page.getByTestId("account-signout").click();
  await expect(page.getByTestId("lobby-signed-out")).toBeVisible();
  await expect(page.getByRole("button", { name: /^sign in$/i }).filter({ visible: true }).first()).toBeVisible();
});

test("a signed-in pilot lands straight on the signed-in lobby", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 12.5 });
  await page.goto("/");
  await expect(page.getByTestId("lobby")).toBeVisible();
  if (!isPhone(page)) await expect(page.getByTestId("cash-card").filter({ visible: true }).first()).toContainText("$12.50");
});
