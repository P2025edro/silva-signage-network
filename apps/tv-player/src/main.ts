// Silva Signage Network — Smart TV web player.
// Runs in the TV's built-in browser. No frameworks: TV browsers are slow and often old.
import { API_BASE, ApiError, call } from './api';
import { eventQueue, kv, mediaCache, pairingStore, tokenStore, uuid, type PendingPairing } from './store';

declare const __PORTAL_URL__: string;
declare const __PLAYER_VERSION__: string;

// Written for old TV engines (Chromium 53+): avoid padStart, Object.entries and other ES2017 library calls.

// ---- Types -------------------------------------------------------------------------
interface Schedule {
  days: number[];
  startMinute: number;
  endMinute: number;
}
interface Item {
  position: number;
  campaignId: string;
  mediaAssetId: string;
  kind: 'IMAGE' | 'VIDEO';
  url: string;
  durationSec: number;
  notAfter: string;
  schedule: Schedule | null;
  timezone: string;
}
interface CachedPlaylist {
  version: number;
  validUntil: string;
  items: Item[];
  /** When the API last confirmed this playlist. Offline playback is bounded from here. */
  confirmedAt: number;
}
interface Config {
  screenId: string;
  displayName: string;
  heartbeatIntervalSeconds: number;
  playlistPollSeconds: number;
  offlineCacheMaxHours: number;
}
type PlaybackState = 'UNKNOWN' | 'PLAYING' | 'IDLE_FALLBACK' | 'STALLED' | 'ERROR';

// ---- DOM ---------------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const imgA = $<HTMLImageElement>('imgA');
const imgB = $<HTMLImageElement>('imgB');
const video = $<HTMLVideoElement>('video');
const panels = { pairing: $('pairing'), fallback: $('fallback'), message: $('message') };
const statusEl = $('status');

function showPanel(name: keyof typeof panels | null, text?: string) {
  for (const k of Object.keys(panels) as Array<keyof typeof panels>) panels[k].className = k === name ? 'panel on' : 'panel';
  if (name === 'message' && text) $('messageText').textContent = text;
  if (name) {
    imgA.className = imgB.className = video.className = 'layer';
  }
}
function setStatus(text: string) {
  statusEl.textContent = text;
  statusEl.className = text ? 'on' : '';
}

// ---- State -------------------------------------------------------------------------
const state = {
  token: tokenStore.get(),
  config: null as Config | null,
  playlist: null as CachedPlaylist | null,
  playbackState: 'UNKNOWN' as PlaybackState,
  lastError: null as string | null,
  lastProgressAt: Date.now(),
  online: true,
  startedAt: Date.now(),
  timers: [] as number[],
  loopToken: 0,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reportError = (msg: string) => {
  state.lastError = msg.slice(0, 480);
};
window.addEventListener('error', (e) => reportError(`script: ${e.message}`));

function platformName(): string {
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return 'Samsung Tizen';
  if (/Web0S|webOS/i.test(ua)) return 'LG webOS';
  if (/Android/i.test(ua)) return /TV|AFT|BRAVIA/i.test(ua) ? 'Android TV' : 'Android';
  if (/CrKey/i.test(ua)) return 'Chromecast';
  return 'Web browser';
}
const supportsH264 = () => {
  try {
    return document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') !== '';
  } catch {
    return false;
  }
};

// ---- Pairing -----------------------------------------------------------------------
async function pairingFlow(): Promise<void> {
  stopTimers();
  state.loopToken++;
  showPanel('pairing');
  $('pairHelp').textContent = `On a phone or computer, sign in at ${__PORTAL_URL__} → Establishments & screens → Pair a screen, and enter this code.`;
  let backoff = 2000;
  for (;;) {
    let pending = pairingStore.get();
    try {
      if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) {
        pending = await call<PendingPairing>('POST', '/api/device/pairing-sessions', { body: { platform: platformName() } });
        pairingStore.set(pending);
      }
      $('code').textContent = pending.code;
      backoff = 2000;
      const result = await pollPairing(pending);
      if (result === 'PAIRED') return startDevice();
      pairingStore.clear(); // expired or unknown: get a new code
    } catch (e) {
      $('code').textContent = '····-····';
      $('pairExpiry').textContent = `Can't reach Silva Signage Network. Retrying… (${e instanceof ApiError ? e.code : 'network'})`;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

async function pollPairing(p: PendingPairing): Promise<'PAIRED' | 'EXPIRED'> {
  for (;;) {
    const left = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 1000));
    $('pairExpiry').textContent = `Code valid for ${Math.floor(left / 60)}:${left % 60 < 10 ? '0' : ''}${left % 60}`;
    if (left === 0) return 'EXPIRED';
    try {
      const r = await call<{ status: string; token?: string }>('GET', `/api/device/pairing-sessions/${p.id}`, { headers: { 'x-poll-secret': p.pollSecret } });
      if (r.status === 'PAIRED' && r.token) {
        tokenStore.set(r.token);
        state.token = r.token;
        pairingStore.clear();
        return 'PAIRED';
      }
      if (r.status !== 'PENDING') return 'EXPIRED';
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return 'EXPIRED';
      // network problem: keep showing the code and keep trying
    }
    await sleep(3000);
  }
}

async function handleUnpaired() {
  tokenStore.clear();
  state.token = null;
  state.playlist = null;
  await kv.del('playlist');
  await mediaCache.clear();
  return pairingFlow();
}

// ---- Device lifecycle -----------------------------------------------------------------
function stopTimers() {
  state.timers.forEach((t) => clearInterval(t));
  state.timers = [];
}

async function startDevice() {
  stopTimers();
  showPanel('message', 'Starting…');
  state.playlist = await kv.get<CachedPlaylist>('playlist');
  // Config may fail while offline; cached content can still play.
  await loadConfig();
  await syncPlaylist();
  const cfg = state.config;
  state.timers.push(window.setInterval(heartbeat, (cfg?.heartbeatIntervalSeconds ?? 30) * 1000));
  state.timers.push(window.setInterval(syncPlaylist, (cfg?.playlistPollSeconds ?? 60) * 1000));
  state.timers.push(window.setInterval(flushEvents, 15_000));
  state.timers.push(window.setInterval(watchdog, 30_000));
  heartbeat();
  requestWakeLock();
  runLoop();
}

async function loadConfig() {
  try {
    state.config = await call<Config>('GET', '/api/device/config', { token: state.token });
    await kv.set('config', state.config);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return handleUnpaired();
    state.config = (await kv.get<Config>('config')) ?? state.config;
  }
}

async function syncPlaylist() {
  try {
    const known = state.playlist?.version;
    const r = await call<{ unchanged: boolean; version: number; validUntil: string; items?: Item[] }>(
      'GET',
      `/api/device/playlist${known ? `?knownVersion=${known}` : ''}`,
      { token: state.token },
    );
    state.online = true;
    setStatus('');
    if (r.unchanged && state.playlist) {
      state.playlist = { ...state.playlist, validUntil: r.validUntil, confirmedAt: Date.now() };
    } else {
      state.playlist = { version: r.version, validUntil: r.validUntil, items: r.items ?? [], confirmedAt: Date.now() };
      prefetchMedia(state.playlist.items);
    }
    await kv.set('playlist', state.playlist);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return handleUnpaired();
    state.online = false;
    setStatus('Offline — playing saved content');
  }
}

let prefetching = false;
async function prefetchMedia(items: Item[]) {
  if (prefetching || !mediaCache.available()) return;
  prefetching = true;
  try {
    const ids = [...new Set(items.map((i) => i.mediaAssetId))];
    for (const item of items) {
      if (!(await mediaCache.has(item.mediaAssetId))) await mediaCache.store(item.mediaAssetId, item.url);
    }
    await mediaCache.retainOnly(ids);
  } finally {
    prefetching = false;
  }
}

// ---- Scheduling checks (mirrors the server, for offline playback) ------------------------
const dayIndex: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function withinSchedule(s: Schedule | null, tz: string, now: Date): boolean {
  if (!s) return true;
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now))
      parts[p.type] = p.value;
    const minute = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    return s.days.indexOf(dayIndex[parts.weekday ?? ''] ?? 0) >= 0 && minute >= s.startMinute && minute < s.endMinute;
  } catch {
    return true; // no time-zone support: rely on the server's filtering when online
  }
}

function playableItems(): Item[] {
  const p = state.playlist;
  const cfg = state.config;
  if (!p) return [];
  const now = Date.now();
  // Cached content is only authorised for a bounded time after the API last confirmed it.
  const maxOfflineMs = (cfg?.offlineCacheMaxHours ?? 24) * 3600_000;
  if (now - p.confirmedAt > maxOfflineMs) return [];
  const d = new Date(now);
  return p.items.filter((i) => new Date(i.notAfter).getTime() > now && withinSchedule(i.schedule, i.timezone, d) && (i.kind !== 'VIDEO' || supportsH264()));
}

// ---- Playback ---------------------------------------------------------------------------
let frontImg = imgA;
let backImg = imgB;
let currentObjectUrl: string | null = null;

function record(type: 'STARTED' | 'COMPLETED' | 'FAILED', item: Item, error?: string) {
  if (!state.playlist) return;
  eventQueue.add({
    id: uuid(),
    type,
    campaignId: item.campaignId,
    mediaAssetId: item.mediaAssetId,
    playlistVersion: state.playlist.version,
    occurredAt: new Date().toISOString(),
    error: error ?? null,
  } as { id: string });
}

async function sourceFor(item: Item): Promise<string> {
  const cached = await mediaCache.objectUrl(item.mediaAssetId);
  return cached ?? item.url;
}

function loadImage(el: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('image load timeout')), 20_000);
    el.onload = () => {
      clearTimeout(t);
      resolve();
    };
    el.onerror = () => {
      clearTimeout(t);
      reject(new Error('image failed to load'));
    };
    el.src = src;
  });
}

async function playImage(item: Item, src: string) {
  await loadImage(backImg, src);
  // Swap only after the new image is ready, so the screen never goes blank.
  backImg.className = 'layer on';
  frontImg.className = 'layer';
  video.className = 'layer';
  if (!video.paused) video.pause();
  [frontImg, backImg] = [backImg, frontImg];
  record('STARTED', item);
  state.playbackState = 'PLAYING';
  await sleep(item.durationSec * 1000);
  record('COMPLETED', item);
}

function playVideo(item: Item, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    const limit = setTimeout(() => cleanup(new Error('video stalled')), (item.durationSec + 15) * 1000);
    const cleanup = (err?: Error) => {
      clearTimeout(limit);
      video.onplaying = video.onended = video.onerror = null;
      if (err) reject(err);
      else resolve();
    };
    video.onplaying = () => {
      if (started) return;
      started = true;
      video.className = 'layer on';
      frontImg.className = 'layer';
      record('STARTED', item);
      state.playbackState = 'PLAYING';
    };
    video.onended = () => {
      record('COMPLETED', item);
      cleanup();
    };
    video.onerror = () => cleanup(new Error(`video error ${video.error?.code ?? ''}`.trim()));
    video.src = src;
    video.load();
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch((e: Error) => cleanup(new Error(`play() rejected: ${e.name}`)));
  });
}

async function runLoop() {
  const token = ++state.loopToken;
  let index = 0;
  while (token === state.loopToken) {
    const items = playableItems();
    if (items.length === 0) {
      showPanel('fallback');
      $('fallbackNote').textContent = state.online ? '' : 'Reconnecting…';
      state.playbackState = 'IDLE_FALLBACK';
      state.lastProgressAt = Date.now();
      await sleep(5000);
      continue;
    }
    showPanel(null);
    const item = items[index % items.length]!;
    index++;
    try {
      const src = await sourceFor(item);
      if (item.kind === 'VIDEO') await playVideo(item, src);
      else await playImage(item, src);
      if (currentObjectUrl && currentObjectUrl !== src) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = src.startsWith('blob:') ? src : null;
      state.lastProgressAt = Date.now();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'playback failed';
      record('FAILED', item, msg);
      reportError(`${item.kind.toLowerCase()} ${item.mediaAssetId}: ${msg}`);
      await sleep(1000); // skip to the next item without spinning
    }
    // Long-running TV browsers leak memory; reload once a day between items.
    if (Date.now() - state.startedAt > 24 * 3600_000) location.reload();
  }
}

function watchdog() {
  if (Date.now() - state.lastProgressAt > 3 * 60_000) {
    state.playbackState = 'STALLED';
    reportError('playback stalled; restarting loop');
    runLoop();
  }
}

// ---- Heartbeat, commands, events ----------------------------------------------------------
async function heartbeat() {
  try {
    const r = await call<{ latestPlaylistVersion: number | null; commands: Array<{ id: string; type: string }> }>('POST', '/api/device/heartbeat', {
      token: state.token,
      body: {
        playbackState: state.playbackState,
        playlistVersion: state.playlist?.version ?? null,
        error: state.lastError,
        playerVersion: __PLAYER_VERSION__,
        platform: platformName(),
        screenWidth: Math.round(window.screen.width * (window.devicePixelRatio || 1)),
        screenHeight: Math.round(window.screen.height * (window.devicePixelRatio || 1)),
        supportsVideo: supportsH264(),
        details: {
          queuedEvents: await eventQueue.size(),
          mediaCache: mediaCache.available(),
          uptimeMinutes: Math.round((Date.now() - state.startedAt) / 60_000),
        },
      },
    });
    state.lastError = null;
    state.online = true;
    if (r.latestPlaylistVersion !== null && r.latestPlaylistVersion !== state.playlist?.version) syncPlaylist();
    for (const c of r.commands) await runCommand(c);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return handleUnpaired();
    state.online = false;
  }
}

async function runCommand(c: { id: string; type: string }) {
  const ack = (success: boolean, result?: Record<string, unknown>) =>
    call('POST', `/api/device/commands/${c.id}/ack`, { token: state.token, body: { success, result } }).catch(() => {});
  switch (c.type) {
    case 'REFRESH_PLAYLIST':
      await syncPlaylist();
      return ack(true, { version: state.playlist?.version });
    case 'REFRESH_CONFIG':
      await loadConfig();
      return ack(true);
    case 'REPORT_DIAGNOSTICS':
      return ack(true, {
        userAgent: navigator.userAgent,
        platform: platformName(),
        apiBase: API_BASE || location.origin,
        playlistVersion: state.playlist?.version ?? null,
        playableItems: playableItems().length,
        queuedEvents: await eventQueue.size(),
        mediaCache: mediaCache.available(),
        h264: supportsH264(),
        uptimeMinutes: Math.round((Date.now() - state.startedAt) / 60_000),
      });
    case 'RELOAD_PLAYER':
      await ack(true);
      location.reload();
      return;
    default:
      return ack(false, { reason: 'unsupported command' });
  }
}

let flushing = false;
async function flushEvents() {
  if (flushing || !state.token) return;
  flushing = true;
  try {
    for (let i = 0; i < 10; i++) {
      const batch = await eventQueue.take(100);
      if (!batch.length) break;
      await call('POST', '/api/device/playback-events', { token: state.token, body: { events: batch } });
      // Accepted, duplicate and rejected events are all final; only network failures are retried.
      await eventQueue.remove(batch.map((e) => e.id));
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) handleUnpaired();
  } finally {
    flushing = false;
  }
}

function requestWakeLock() {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } }).wakeLock;
  wl?.request('screen').catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

// ---- Boot ----------------------------------------------------------------------------------
if (state.token) startDevice();
else pairingFlow();
