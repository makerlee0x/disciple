# Always-on trade relay (Fly.io)

Gasless trades normally go to `POST /api/gasless` on Vercel. Vercel starts and freezes copies of the server on demand,
so a trade often lands on a cold copy and pays ~0.7 s of fresh RPC / sequencer connections. The always-on relay is the
same handler (`lib/server/gaslessRpc.ts`) running as one long-lived Node process (`web/relay/server.ts`) that keeps
those connections, the relayer key leases, nonces, base fee and Privy keys hot every 2 s.

The site uses it only when `NEXT_PUBLIC_GASLESS_RELAY_URL` is set **and** its last ping answered (within 2 min).
Otherwise trades go to Vercel exactly as before. A trade is never re-sent to the other relay.

## One-time setup (Team)

1. Install flyctl and sign up / log in: `brew install flyctl` then `fly auth login`.
2. From the repo root, create the app (pick another name if taken, and put it in `web/relay/fly.toml`):
   `fly apps create disciple-relay`
3. Secrets: the relay needs the same server env as Vercel Production.
   - `cd web && vercel env pull .env.relay --environment=production && cd ..`
   - `fly secrets import --config web/relay/fly.toml < web/.env.relay`
   - `rm web/.env.relay`
   - Vercel "Sensitive" variables come back empty from `env pull`. Set those by hand, for example:
     `fly secrets set --config web/relay/fly.toml RELAYER_PRIVATE_KEY=… RELAYER_POOL_SEED=…`
     (relayer key / pool seed, Upstash KV token, Privy keys, RH_SEQUENCER_URL, RH_RECEIPT_RPC_URL as on Vercel).
4. Deploy from the repo root:
   `fly deploy . --config web/relay/fly.toml --dockerfile web/relay/Dockerfile --ignorefile web/relay/Dockerfile.dockerignore`
5. Check: `curl https://disciple-relay.fly.dev/health` prints `ok`. `fly logs --config web/relay/fly.toml` should show
   `[relay] listening on :8080` and no `relayer not configured`.
6. Vercel → Settings → Environment Variables (Production): `NEXT_PUBLIC_GASLESS_RELAY_URL = https://disciple-relay.fly.dev`,
   then redeploy (it is a build-time variable).
7. Trade on a coin page with `?timing=1`: the box's `server instance` line should show a large uptime.

## Updating

Re-run step 4 after relay changes merge to main (the relay is not deployed by Vercel).

## Turning it off

Delete `NEXT_PUBLIC_GASLESS_RELAY_URL` on Vercel and redeploy. Trades go back to `/api/gasless`. Then
`fly scale count 0 --config web/relay/fly.toml` (or `fly apps destroy disciple-relay`).

## Knobs (fly.toml `[env]`)

- `RELAY_LEASES` (4): relayer pool keys this server holds and rotates (capped by the pool size). Vercel copies take
  any keys left over, and the main key is the fallback as before (shared KV nonce allocator).
- `RELAY_LEASE_TTL_SEC` (300): lease length; renewals every TTL/3.
- `RELAY_ALLOWED_ORIGINS`: sites allowed to call it (CORS).
- `RELAY_HOT_MS` (2000): keep-hot interval.
