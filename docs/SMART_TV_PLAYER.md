# Smart TV player

`apps/tv-player` — a single HTML page and a ~14 KB script. Intended address: `https://player.silvasolutions.ie` (a deployment target, not yet configured).

## Setting up a TV

1. On the TV, open the built-in web browser and go to the player address.
2. The screen shows **Pair this screen** with an 8-character code (valid 10 minutes; a new one appears automatically).
3. On a phone or computer, the business owner signs in → **Establishments & screens → Pair a screen**, enters the code, picks the establishment and names the screen.
4. Within a few seconds the TV starts playing its playlist, or the Silva holding slide if nothing is scheduled.

Tips: set the TV's browser start page to the player address, disable screen savers / eco auto-off, and use the TV's own power schedule. The browser player **cannot** turn the TV on or off or relaunch the browser after a power cut — see `KNOWN_LIMITATIONS.md`.

## Configuration

| Setting | How |
|---|---|
| API address | Build-time `PLAYER_API_URL`, or `?api=https://api.example` on the player URL, else same origin |
| Portal address shown on the pairing screen | Build-time `PLAYER_PORTAL_URL` |
| Heartbeat interval, offline cache limit | Platform settings (admin → Settings), sent to the player via `/api/device/config` |

```bash
PLAYER_API_URL=https://api.silvasolutions.ie PLAYER_PORTAL_URL=app.silvasolutions.ie pnpm --filter @silva/tv-player build   # → apps/tv-player/dist
```

## Behaviour

| Concern | Implementation |
|---|---|
| Identity | Device token in `localStorage`; on `401 DEVICE_NOT_PAIRED` the player wipes its cache and returns to pairing. |
| Playlist sync | Every 60 s (`knownVersion` avoids re-downloading), immediately when a heartbeat reports a newer version, and on `REFRESH_PLAYLIST`. |
| Heartbeat | Every 30 s: playback state, playlist version, last error, player version, platform, resolution, H.264 support, queued-event count. |
| Commands | `REFRESH_PLAYLIST`, `REFRESH_CONFIG`, `RELOAD_PLAYER`, `REPORT_DIAGNOSTICS`; each is acknowledged. |
| Playback | Images: preloaded into a hidden layer and swapped only when decoded (no blank frames). Video: muted, sequential, `ended` → next; 15 s grace beyond duration then treated as stalled. Unsupported or failing media is skipped and reported. |
| Fallback | Branded holding slide when nothing is playable. |
| Watchdog | No progress for 3 minutes → state `STALLED`, loop restarted. Daily self-reload to contain memory leaks. |
| Events | `STARTED`, `COMPLETED`, `FAILED` with player-generated UUIDs, queued in IndexedDB (memory fallback), sent every 15 s in batches of 100. `SCHEDULED` is reserved and not emitted by this player to keep event volume down. |
| Offline | Latest playlist in IndexedDB; media in Cache Storage (pruned to the current playlist). Plays cached content for at most `devices.offline_cache_max_hours` (24 h) after the API last confirmed the playlist, never past an item's `notAfter`, and re-checks campaign schedules locally where `Intl` time zones are supported. Pauses/revocations reach a TV only once it is back online. |

## Compatibility

Built for Chromium 53+ (Tizen 4+, webOS 4+) and modern Android TV browsers: esbuild down-levels syntax, and the code avoids ES2017+ library calls. Optional APIs (Cache Storage, IndexedDB, AbortController, Wake Lock, `Intl.formatToParts`) are feature-detected.

**Tested so far:** desktop Chromium 141 (headless, via Playwright) only. **No real TV has been tested.** Record results per model before claiming support:

| Manufacturer | Model | OS / version | Browser version | Pairing | Images | Video (H.264) | Offline cache | Notes |
|---|---|---|---|---|---|---|---|---|
| Samsung | | Tizen | | ☐ | ☐ | ☐ | ☐ | |
| LG | | webOS | | ☐ | ☐ | ☐ | ☐ | |
| Sony / TCL / Philips | | Android TV / Google TV | | ☐ | ☐ | ☐ | ☐ | |

Test checklist per TV: pairing; image rotation for 1 hour; 1080p H.264 video; unplug network for 10 minutes (keeps playing, events sync after); pause a campaign (disappears within ~1 minute); unpair (returns to code); browser restart behaviour; overnight run (memory).
