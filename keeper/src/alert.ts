// Alerts and a liveness ping, for a keeper that runs unattended (a server, not a terminal).
//   ALERT_URL      where to send alerts. A Discord webhook (discord.com/api/webhooks/...) gets {"content"}, a Slack
//                  webhook (hooks.slack.com/...) gets {"text"}, anything else gets the plain text as the POST body
//                  (ntfy.sh/<topic> works that way and pushes to the ntfy phone app).
//   HEARTBEAT_URL  pinged (GET) at most once every HEARTBEAT_EVERY_SEC (default 60) while same-chain rounds succeed.
//                  Point it at a dead-man's switch such as healthchecks.io: it alerts when the pings STOP, which also
//                  covers the server itself going down, which nothing on the server can report.
// Both are optional; unset, the keeper only logs. Neither URL is ever logged.

const env = process.env;
const lastSent = new Map<string, number>();
let lastBeat = 0;

function body(url: string, text: string): { headers: Record<string, string>; body: string } {
  if (/discord(app)?\.com\/api\/webhooks\//.test(url)) return { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) };
  if (/hooks\.slack\.com\//.test(url)) return { headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) };
  return { headers: { "content-type": "text/plain; charset=utf-8", Title: "Carry keeper" }, body: text };
}

/** Sends `text` to ALERT_URL, at most once per `key` every `everySec` (default 6 h). Never throws. */
export async function alert(key: string, text: string, everySec = 6 * 3600): Promise<void> {
  const url = env.ALERT_URL;
  if (!url) return;
  const t = Date.now() / 1000;
  if ((lastSent.get(key) ?? 0) + everySec > t) return;
  lastSent.set(key, t);
  try {
    const b = body(url, `${env.KEEPER_NAME ?? "keeper"}: ${text}`);
    await fetch(url, { method: "POST", ...b, signal: AbortSignal.timeout(10_000) });
  } catch {
    /* an alert that cannot be sent must not stop the keeper */
  }
}

/** Pings HEARTBEAT_URL when the last interval has passed. Call after a round that worked. Never throws. */
export async function heartbeat(): Promise<void> {
  const url = env.HEARTBEAT_URL;
  if (!url) return;
  const t = Date.now() / 1000;
  if (lastBeat + Number(env.HEARTBEAT_EVERY_SEC ?? 60) > t) return;
  lastBeat = t;
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    /* next round tries again */
  }
}
