/** Host a launch: the builder (launch flow board, signed off 2026-11-13) and what happens when you light the engines. */
import { test, expect, hydrated } from "./support/fixtures";

test("the pad preview follows what you type and pick", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "Launch control" })).toBeVisible();
  await page.getByRole("textbox", { name: /name/i }).first().fill("E2E Comet");
  await expect(page.getByTestId("pad-name")).toContainText("E2E COMET", { ignoreCase: true });
  await page.getByTestId("mode-card-hard").click();
  await expect(page.getByTestId("mode-card-hard")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("pad-mode")).toContainText(/hard/i);
  // a hidden launch always flies on Expert
  await page.getByTestId("private-launch").click();
  await expect(page.getByTestId("private-launch-help")).toHaveText("Hidden launches fly on Expert.");
  await expect(page.getByTestId("pad-mode")).toContainText(/expert/i);
});

test("a rocket needs a name before it can launch", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await page.getByRole("textbox", { name: /name/i }).first().fill("");
  await page.getByTestId("create-launch").click();
  await expect(page.getByRole("status").filter({ hasText: /name/i }).first()).toHaveText(/Give your rocket a name and a ticker\./);
});

test("Advanced holds host fees and the creator tax stepper", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await page.getByTestId("advanced-open").click();
  const m = page.getByTestId("advanced-modal");
  await expect(m).toBeVisible();
  const tax = m.getByTestId("creator-tax-value"), before = await tax.textContent();
  await m.getByRole("button", { name: "Raise creator tax" }).click();
  await expect(tax).not.toHaveText(before!);
  await m.getByRole("button", { name: "Close" }).click();
  await expect(m).toBeHidden();
  await expect(page.getByTestId("fee-destination-chip")).toBeVisible();
});

test("lighting the engines when the chain says no ends in plain words, with the form kept", async ({ page, pilot }) => {
  await pilot.signIn({ cash: 25 });
  await page.goto("/create");
  await page.getByRole("textbox", { name: /name/i }).first().fill("E2E Comet");
  const go = page.getByTestId("create-launch");
  await go.click();
  const status = page.getByRole("status").filter({ hasNotText: /^$/ }).last();
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(go).toHaveText(/Light the engines/, { timeout: 30_000 });
  await expect(status).not.toHaveText(/undefined|\[object|0x[0-9a-f]{8}|revert|execution|relayer|HTTP \d|rpc/i);
  await expect(page.getByTestId("launch-live")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /name/i }).first()).toHaveValue("E2E Comet");
});

test("signed out, the launch button signs you in", async ({ page }) => {
  await page.goto("/create");
  const btn = page.getByTestId("create-sign-in");
  await expect(btn).toBeVisible();
  await hydrated(btn);
  await btn.click();
  await expect(page.getByTestId("create-launch")).toBeVisible();
});
