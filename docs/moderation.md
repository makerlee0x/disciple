# Rocket icon moderation

Contracts store only the **metadata URI**. That URI is created only after the image passes `/api/moderate-image`.

## Flow

1. **Browser pre-check** (`web/lib/moderation-client.ts`): nsfwjs MobileNetV2 runs on tfjs and gives instant feedback. If it blocks, the preview and the launch are both blocked. Model files are static in `web/public/models/nsfw/mobilenet_v2/`, exported by `node web/scripts/export-nsfw-model.cjs` because webpack can't parse nsfwjs's bundled shards.
2. **Server check (authoritative)** at `POST /api/moderate-image` (multipart `file`):
   - type and size: PNG/JPG/WEBP/GIF (checked by magic bytes via sharp), ≤ 2 MB
   - normalisation: EXIF orientation is baked in, then resized to ≤ 1024 px and re-encoded to WebP. **All metadata (EXIF/GPS/ICC) is stripped.**
   - hashing: sha256 of the normalised bytes plus a 64-bit dHash perceptual hash
   - denylist: an exact sha256 match or a pHash Hamming distance ≤ 6 means `block`
   - provider verdict: `allow | block | review`. A provider error returns `review` (fails closed).
   - `block` adds the hashes to the denylist. `allow` stores the image and returns `imageUri`.
3. The UI shows "This image can't be used" for block and "Held for review" for review. Launch requires `allow` + `imageUri`. Moderation status is stored with the coin metadata (`CoinMetadata.image` in `lib/protocol.ts`).

Thresholds live in `MODERATION` in `web/lib/config.ts`. **block:** Porn > 0.6, Hentai > 0.6, Sexy > 0.85. **review:** Porn/Hentai > 0.35, Sexy > 0.6.

## Providers (`web/lib/server/moderation.ts`)

| `MODERATION_PROVIDER` | Env | Notes |
|---|---|---|
| `rekognition` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, (`AWS_SESSION_TOKEN`) | DetectModerationLabels, SigV4 signed without the SDK |
| `google` | `GOOGLE_VISION_API_KEY` | SafeSearch adult/racy likelihood mapped to scores |
| `sightengine` | `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET` | `nudity-2.1` model |
| `nsfwjs` (fallback) | – | server-side nsfwjs on **pure-JS** `@tensorflow/tfjs` (about 2.5 s cold, then fast). We skipped `tfjs-node` because its native build is too heavy. |
| `mock` | `MODERATION_MOCK_SCORES='{"Porn":0.9}'` | tests only, refused in production unless `MODERATION_ALLOW_MOCK=1` |

If `MODERATION_PROVIDER` is unset, the server uses the first configured provider in the order rekognition → google → sightengine, and falls back to nsfwjs. None are configured in this PR.

Storage stubs: `DENYLIST_PATH` (default `web/.data/denylist.json`) and `IMAGE_STORE_DIR` (default `web/.data/images`). Swap them for KV and IPFS/R2 in production. `imageUri` is a `disciple-img://<sha256>` placeholder.

## After launch

A token's image URI **can't be blocked on-chain**. The indexer must re-scan, and it should set `CoinMetadata.hidden = true` when an image is flagged after launch. The UI already drops `hidden` coins from the launchpad grid. The coin page should do the same once the indexer is wired.

## Testing

`web/scripts/test-moderation.sh` uses only safe images plus **synthetic mocked scores** (no real explicit content). The client can also take a dev-only `?modmock=porn|sexy|review`.
