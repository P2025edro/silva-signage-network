# Admin manual (Silva Solutions staff)

Sign in at the web app. Super admins must set up two-factor authentication at first sign-in and enter a code every session.

## Daily routine

1. **Overview** — screens online, campaigns awaiting review, playback in the last 24 h. A yellow banner means development fixtures exist.
2. **Alerts** — offline, erroring or stalled screens; reviews waiting over 24 h; failed payments.
3. **Campaigns → Awaiting review** — review each one (below).

## Onboarding a business

1. **Companies → New company.** Enter details; tick *development / test fixture* only for test data. Optionally create the owner's sign-in with a temporary password and share it securely.
2. On the company page, **Grant manual subscription** for pilots, or ask the owner to subscribe online (Subscription page) once Stripe is configured. Manual subscriptions grant entitlements but never count as revenue.
3. The owner adds establishments and pairs screens from their portal. You can also add/edit establishments from the company page.

## Reviewing campaigns

Open the campaign → click a creative to view it full size. Check:
- the advertiser has rights to every image, logo, font and music track;
- claims are accurate and comply with the ASAI Code and sector rules (alcohol, gambling, health, children);
- it suits all ages and the targeted venues.

Then **Approve** (goes live immediately or at its start date), **Request changes** (with a reason — the business can edit and resubmit) or **Reject** (with a reason). **Priority** (1–5) changes the campaign's share of loops; leave at 3 unless agreed commercially.

Live campaigns can be **Paused**, **Resumed** or **Cancelled**. Screens pick up changes within about a minute while online.

## Screens

**Smart TVs** lists every screen with live status. Click one for details, the current loop and why each campaign is or isn't included. Actions: refresh playlist, refresh configuration, reload player, request diagnostics (the player's reply is stored with the command; it is not yet shown in this screen), disable/enable, unpair (revokes the device immediately).

Status meanings: *Playback active* — playing adverts; *Online* — connected, showing the holding slide; *Sync pending* — hasn't loaded the newest playlist yet; *Playback stalled* — connected but not progressing; *Error detected* — the player reported an error; *Offline* — no heartbeat for 2 minutes; *Not connected yet* — paired but never reported in.

## Advertising network

Shows each screen's loop. **Regenerate all** rebuilds every playlist immediately (normally automatic). Network rules (slots per loop, max share per advertiser, own-screen policy, host subscription requirement) are in **Settings**.

## Establishments and rules

**Establishments** lists all premises. *Categories* sets which business categories may advertise there; *Advertisers* excludes specific businesses (e.g. a direct competitor).

## Zones

Create zones for new areas or cities. Deactivating a zone stops new targeting; existing campaigns targeting it only reach screens still in other matching zones.

## Subscriptions and billing

**Subscriptions** — edit plan prices (mark *draft* until approved), Stripe price IDs and entitlements; see and cancel manual subscriptions. **Billing** — verified Stripe events only; warns if Stripe isn't configured.

## Analytics and audit

**Analytics** — playback by day, zone, venue type and campaign, with CSV export. Counts are what screens reported, not audience estimates. **Audit logs** (super admin) — every sign-in, pairing, review decision, subscription change and setting change.

## Settings

Platform settings (super admin to change), Silva staff accounts (super admin), and your own password and two-factor setup.
