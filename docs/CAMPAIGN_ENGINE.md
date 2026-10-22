# Distribution engine

Code: `packages/shared/src/engine/`. Tests: `packages/shared/test/`. Pure functions — no database, clock or randomness.

## Eligibility

A screen first passes screen-level gates; failing any gives a fallback-only playlist:

| Reason | Rule |
|---|---|
| `SCREEN_NOT_ACTIVE` | Screen is disabled or unpaired |
| `HOST_SUSPENDED` | Host company suspended |
| `HOST_SUBSCRIPTION_INACTIVE` | Host has no active subscription (setting `distribution.require_host_subscription`) |
| `LOCATION_NOT_PARTICIPATING` | Establishment opted out of network ads |
| `LOCATION_CLOSED` | Outside recorded opening hours (none recorded = no restriction) |

Then every campaign is checked; **all** failing reasons are recorded on the playlist (`screen_playlists.decisions`) so operators can answer "why isn't my ad on that screen?":

`CAMPAIGN_NOT_APPROVED`, `BEFORE_START`, `AFTER_END`, `OUTSIDE_SCHEDULE`, `ADVERTISER_SUSPENDED`, `SUBSCRIPTION_INACTIVE` (must be ACTIVE/TRIALING and inside its paid period), `QUOTA_EXHAUSTED` (STARTED plays this period ≥ `monthly_playback_allocation`), `OWN_SCREEN` (setting `distribution.allow_own_screens`, default false), `ZONE_MISMATCH`, `VENUE_CATEGORY_NOT_TARGETED`, `VENUE_CATEGORY_EXCLUDED`, `ADVERTISER_EXCLUDED_BY_HOST`, `CATEGORY_BLOCKED_BY_HOST`, `CATEGORY_NOT_ALLOWED_BY_HOST`, `NO_COMPATIBLE_MEDIA`.

**Competition-rule conflicts:** a specific advertiser exclusion and a category BLOCK always win over an ALLOW. If a host has any ALLOW rules, only those categories may play.

**Media compatibility:** images always; video only if the player hasn't reported lacking video support, the delivery rendition is H.264, and it's no longer than `maxVideoSeconds`.

## Allocation policy (measurable)

1. **Selection** — if eligible campaigns exceed `slots_per_loop` (default 12), rank by delivery ratio (plays ÷ allocation, ascending), then weight, then id. Unselected campaigns are flagged `displacedByCapacity` — this is the visible shortfall signal.
2. **Minimum guarantee** — each selected campaign gets 1 slot.
3. **Proportional share** — remaining slots assigned one at a time by Sainte-Laguë on `weight = plan distribution_weight × campaign priority (1–5)`.
4. **Anti-monopoly cap** — with ≥2 advertisers, one advertiser holds at most `floor(slots × max_advertiser_share)` slots (default 0.4 → 4 of 12), across all its campaigns. Slots nobody may take shorten the loop.
5. **Compression** — counts are divided by their largest common divisor that still shows every creative.
6. **Ordering** — smooth weighted round-robin spreads each campaign through the loop.
7. **Creative rotation** — the creative used by a slot shifts every quarter hour.

## Versioning and validity

`validUntil = min(next quarter hour, earliest included campaign end, earliest pending campaign start)`. The API stores a new `screen_playlists` version only when the fingerprint changes. Every item carries `notAfter` = campaign end, so cached items can't outlive the campaign.

## Capacity

`estimateDailyPlays(slotsInLoop, loopSeconds, openingHours, weekday)` and `deliveryShortfall(requested, estimated)` give a planning estimate. It is not a delivery promise and says nothing about audience — a completed playback means the player reported it, not that a person saw it.

## Where it runs

`apps/api/src/services/playlists.ts` loads the snapshot (one query for campaigns with their subscription, quota usage, targeting and media; one for screens with zones and host rules), calls `buildScreenPlaylist` per screen, and persists a new version only when the content fingerprint changes. Each version stores the engine's per-campaign decisions, shown to Silva staff in *Advertising network* and *Smart TVs*.

## Playback event types

The player reports `STARTED`, `COMPLETED` and `FAILED`. `SCHEDULED` exists in the schema but is not emitted by the current player — what was scheduled is recorded as `delivery_allocations` per playlist version instead, which keeps event volume proportional to actual plays. Quotas count `STARTED` events within the advertiser's current subscription period.
