# Deployment

**Nothing has been deployed.** This is the intended production shape. No paid services have been purchased.

## Components

| Component | Recommended host | Notes |
|---|---|---|
| Web app (`apps/web`) | Vercel (static) | `pnpm --filter @silva/web build` → `apps/web/dist`. SPA: rewrite all paths to `/index.html`. Set `VITE_API_URL` if the API is on another host. |
| TV player (`apps/tv-player`) | Vercel or any static host, e.g. `player.silvasolutions.ie` | `PLAYER_API_URL=… pnpm --filter @silva/tv-player build` → `dist/`. Must be HTTPS (Cache Storage needs a secure context). |
| API (`apps/api`) | A persistent Node host — Render, Railway, Fly.io, or a small VM | Long-lived process; needs `ffmpeg`/`ffprobe` on PATH for video. Not Vercel functions (uploads, transcoding and Range responses don't fit). |
| Worker | Same host as API, second process | `pnpm --filter @silva/api worker`. Safe to run several (advisory locks). |
| PostgreSQL 16 | Managed (Neon, Supabase, RDS, Render) | EU region (e.g. eu-west-1 Ireland). Daily backups + PITR. |
| Object storage | S3-compatible (AWS S3 eu-west-1, Cloudflare R2, Backblaze) | Private bucket; `STORAGE_DRIVER=s3`. **The S3 driver is written but untested** — verify before launch. |
| Stripe | Stripe Billing | Create products/prices, put price IDs on plans (Admin → Subscriptions), webhook → `https://api…/api/billing/stripe/webhook` with events `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`. |

## Domains

Keep the web app and API on the **same site** so the session cookie stays first-party, e.g. `app.silvasolutions.ie` + `api.silvasolutions.ie`. Set `WEB_ORIGINS=https://app.silvasolutions.ie` and `API_PUBLIC_URL=https://api.silvasolutions.ie`. The player can live anywhere; device routes accept any origin and use bearer tokens.

## Production environment

```
NODE_ENV=production
DATABASE_URL=postgres://…?sslmode=require
API_PUBLIC_URL=https://api.silvasolutions.ie
WEB_ORIGINS=https://app.silvasolutions.ie
APP_SECRET=<openssl rand -base64 48>     # never reuse dev values; rotating it invalidates TOTP enrolments
STORAGE_DRIVER=s3
S3_REGION=eu-west-1
S3_BUCKET=…
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
# ALLOW_ADMIN_WITHOUT_MFA must be unset (startup refuses true in production)
```

## Release steps

1. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`
2. `DATABASE_URL=… pnpm db:migrate` (additive migrations only; take a backup first)
3. Deploy API + worker, then web app and player.
4. First admin (once): `SEED_ADMIN_EMAIL=you@silvasolutions.ie SEED_ADMIN_PASSWORD='<long passphrase>' pnpm db:seed` with production env vars. It only creates the admin (no fixtures; `--demo` is refused in production). Sign in and enrol two-factor authentication immediately.
5. Smoke test: `/api/health`, sign in, pair a test TV, approve a test campaign.

## Monitoring

- Uptime check on `/api/health`.
- Admin → Alerts shows offline/stalled screens, overdue reviews and billing failures.
- Ship API logs (JSON, pino) to a log service; alert on 5xx rate.

## Backup and recovery

- Managed Postgres PITR (7+ days) and a nightly logical dump kept 30 days in a different provider/region.
- Object storage versioning on the media bucket.
- Restore drill before launch: restore a dump into a scratch database, run `pnpm test:db` against it, and point a staging API at it.
