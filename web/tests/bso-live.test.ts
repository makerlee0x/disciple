/** Gated operational harness. Only the server-only build marker is stubbed in Node;
 * the actual proxy, admission, rate limits, invitations and provider are not mocked.
 */
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
it.skipIf(process.env.PHASE2_TESTNET_RUN !== "1")("runs the approved bounded testnet matrix", async () => {
  const { phase2Evidence } = await import("../scripts/gasless-phase2.mjs");
  expect(phase2Evidence.status).toBe("matrix complete (budget/traces explicit limitations)");
}, 240_000);
