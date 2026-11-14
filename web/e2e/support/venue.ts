/**
 * Stand-in for Hyperliquid's public price feed (lib/turbo/priceFeed), which Turbo's stand-in adapter reads: the info
 * POST and the WebSocket both answer with a BTC/ETH price that drifts up a little every 200 ms, so a run has a moving
 * market and a test can count on it.
 */
import type { Page } from "@playwright/test";

export async function fakeVenue(page: Page, o: { btc?: number; eth?: number; drift?: number } = {}) {
  let btc = o.btc ?? 97_000, eth = o.eth ?? 3_500;
  const drift = o.drift ?? 0.00002;
  const mids = () => ({ BTC: btc.toFixed(1), ETH: eth.toFixed(2) });
  await page.route("https://api.hyperliquid.xyz/info", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mids()) }));
  await page.routeWebSocket("wss://api.hyperliquid.xyz/ws", (ws) => {
    const t = setInterval(() => {
      btc *= 1 + drift; eth *= 1 + drift;
      ws.send(JSON.stringify({ channel: "allMids", data: { mids: mids() } }));
    }, 200);
    ws.onMessage(() => { ws.send(JSON.stringify({ channel: "subscriptionResponse", data: {} })); });
    ws.onClose(() => clearInterval(t));
  });
}
