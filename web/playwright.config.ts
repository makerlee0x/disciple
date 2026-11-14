/**
 * End-to-end suite (e2e/). Runs the real production build against a stand-in chain, on a desktop and a phone size.
 *
 *   pnpm e2e:build        build once with the e2e env (stand-in chain, local sign-in)
 *   pnpm e2e              run every flow + screenshot check (starts the chain and `next start` itself)
 *   pnpm e2e:update       re-take the screenshot baselines after a signed-off design change
 *
 * See e2e/README.md for what is covered and how sign-in, cash and the chain are faked.
 */
import { defineConfig, devices } from "@playwright/test";

const APP_PORT = Number(process.env.E2E_APP_PORT || 3210);
const CHAIN_PORT = Number(process.env.E2E_CHAIN_PORT || 8545);
export const E2E_ENV = {
  NEXT_PUBLIC_AA_SIGNER: "local",
  NEXT_PUBLIC_RHT_RPC_URL: `http://127.0.0.1:${CHAIN_PORT}`,
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_DIST_DIR: ".next-e2e",
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  snapshotPathTemplate: "{testDir}/__screens__/{projectName}/{arg}{ext}",
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide", scale: "css" } },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "e2e/.report" }]] : [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // the pre-installed browser in cloud sessions; CI installs its own with `playwright install chromium`
    launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "dark",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // Pixel 7 runs on Chromium (no WebKit download needed) with touch + a phone viewport
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    { command: `node e2e/support/mock-chain.mjs ${CHAIN_PORT}`, url: `http://127.0.0.1:${CHAIN_PORT}/`, reuseExistingServer: !process.env.CI, stdout: "ignore" },
    {
      command: `pnpm exec next start -p ${APP_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}/api/daily`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...E2E_ENV, KV_ALLOW_LOCAL: "1", TRUSTED_PROXY: "1", TURBO_PASSWORD: "e2e-turbo", KV_LOCAL_FILE: process.env.E2E_KV_FILE || "/tmp/disciple-e2e-kv.json", DAILY_SEED_SECRET: "e2e-daily-seed-secret-0123456789" },
    },
  ],
});
