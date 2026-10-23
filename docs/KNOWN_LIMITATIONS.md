# Known limitations and unimplemented features

## Hardware and player

- **No real TV has been tested.** Samsung Tizen, LG webOS and Android TV compatibility is designed for (Chromium 53+ target, feature detection) but unverified.
- A browser player **cannot** power the TV on/off, reboot it, or relaunch the browser after a power cut. Use the TV's power schedule and set the browser start page; consider kiosk/"signage" modes or a native Tizen/webOS app later.
- Some TV browsers may not support Cache Storage or may evict it; the player then streams media and cannot play offline.
- Video plays **muted** (autoplay policies). Audio is not supported.
- Offline playback is bounded to 24 h after last confirmation; pausing or cancelling a campaign only reaches a TV once it reconnects.
- The player stores its device token in `localStorage`. Anyone with physical access to the TV's browser could read it; it only grants that screen's playlist and can be revoked by unpairing.

## Product features not yet built

- Stripe Checkout and Billing Portal are wired but **untested against Stripe** (no account configured). Plans have no Stripe price IDs yet. VAT handling is not configured and must be confirmed by an accountant.
- No email: no password reset, invitations or notification emails. Initial passwords are set by an owner/admin and must be shared securely. **Password reset is a priority follow-up.**
- No user data export or full account erasure workflow (GDPR).
- A user belongs to one company (adding an existing email to a second company is refused).
- Screen diagnostics replies are stored but not displayed in the admin UI.
- No per-establishment screen schedule (other than opening hours), no multi-zone screen layouts, no portrait screens, no HTML/web-page content types.
- Playback "SCHEDULED" events are not emitted by the player (allocations are recorded instead).
- Media library has no delete button in the UI (API supports it).
- Campaign priority is Silva-only; there is no paid "boost".
- Analytics are counts of reported playback; there are no audience or impression estimates by design.
- Long admin lists (screens, locations, subscriptions) are not paginated yet; fine for the pilot scale.

## Infrastructure

- **Not deployed.** No DNS, hosting, managed database or bucket has been set up.
- S3 storage driver is implemented but untested; local disk storage is used in development.
- Playlist regeneration recomputes every screen on each change — fine for hundreds of screens, needs targeted regeneration for thousands (`ARCHITECTURE.md` §8).
- Rate limiting is in-memory per API instance (use a shared store such as Redis when running several instances).
- No CI pipeline, dependency scanning or error-tracking service configured.
- Device credential rotation is manual (unpair/re-pair); no scheduled rotation.
- Retention policy for audit logs, playback events and billing events is not decided.

## Online demo (Vercel)

- Video uploads are switched off (no ffmpeg in Vercel functions); images only, up to 4 MB per request (bigger photos are shrunk in the browser first).
- Scheduling runs from API traffic rather than a worker process: campaign start/end can lag by up to a minute or two when no TV is polling.
- The demo uses its own database with fictional `DEMO —` businesses. It is not the production system and takes no payments.

## Development environment notes

- Built and tested on Node 22, PostgreSQL 16, ffmpeg 6+, Chromium 141 (Playwright).
- `docker-compose.yml` was written but not run in this environment (no image pulls available); PostgreSQL ran natively.
