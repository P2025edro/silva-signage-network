// Local persistence: localStorage for small values, IndexedDB for the event queue and
// playlist, Cache Storage for media. Every API here degrades to "not available" instead of
// throwing, because TV browsers differ and storage can be evicted at any time.

const TOKEN_KEY = 'silva.deviceToken';
const PAIRING_KEY = 'silva.pairing';

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable: pairing will be needed after reload */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PAIRING_KEY);
    } catch {
      /* ignore */
    }
  },
};

export interface PendingPairing {
  id: string;
  code: string;
  pollSecret: string;
  expiresAt: string;
}
export const pairingStore = {
  get(): PendingPairing | null {
    try {
      const v = localStorage.getItem(PAIRING_KEY);
      return v ? (JSON.parse(v) as PendingPairing) : null;
    } catch {
      return null;
    }
  },
  set(p: PendingPairing) {
    try {
      localStorage.setItem(PAIRING_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  },
  clear() {
    try {
      localStorage.removeItem(PAIRING_KEY);
    } catch {
      /* ignore */
    }
  },
};

// ---- IndexedDB -----------------------------------------------------------------
let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (!('indexedDB' in window)) return resolve(null);
        const req = indexedDB.open('silva-player', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise<T | null>((resolve) => {
        if (!d) return resolve(null);
        try {
          const req = fn(d.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const kv = {
  get: <T>(key: string) => tx<T>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T>),
  set: (key: string, value: unknown) => tx('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key: string) => tx('kv', 'readwrite', (s) => s.delete(key)),
};

// In-memory fallback when IndexedDB is unavailable.
const memoryQueue = new Map<string, unknown>();
export const eventQueue = {
  async add(event: { id: string }) {
    const ok = await tx('events', 'readwrite', (s) => s.put(event));
    if (ok === null) memoryQueue.set(event.id, event);
  },
  async take(limit: number): Promise<Array<{ id: string }>> {
    const all = ((await tx<Array<{ id: string }>>('events', 'readonly', (s) => s.getAll() as IDBRequest<Array<{ id: string }>>)) ?? []).concat([
      ...memoryQueue.values(),
    ] as Array<{ id: string }>);
    return all.slice(0, limit);
  },
  async remove(ids: string[]) {
    for (const id of ids) {
      memoryQueue.delete(id);
      await tx('events', 'readwrite', (s) => s.delete(id));
    }
  },
  async size(): Promise<number> {
    return ((await tx<number>('events', 'readonly', (s) => s.count())) ?? 0) + memoryQueue.size;
  },
};

// ---- Media cache -----------------------------------------------------------------
const CACHE = 'silva-media-v1';
const keyFor = (mediaId: string) => `${location.origin}/__media/${mediaId}`;
const hasCache = () => typeof caches !== 'undefined' && window.isSecureContext !== false;

export const mediaCache = {
  available: hasCache,
  async has(mediaId: string): Promise<boolean> {
    if (!hasCache()) return false;
    try {
      return Boolean(await (await caches.open(CACHE)).match(keyFor(mediaId)));
    } catch {
      return false;
    }
  },
  /** Downloads into the cache. Returns false on quota or network errors (playback then streams). */
  async store(mediaId: string, url: string): Promise<boolean> {
    if (!hasCache()) return false;
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) return false;
      await (await caches.open(CACHE)).put(keyFor(mediaId), res);
      return true;
    } catch {
      return false;
    }
  },
  async objectUrl(mediaId: string): Promise<string | null> {
    if (!hasCache()) return null;
    try {
      const res = await (await caches.open(CACHE)).match(keyFor(mediaId));
      return res ? URL.createObjectURL(await res.blob()) : null;
    } catch {
      return null;
    }
  },
  /** Bounded cache: anything not in the current playlist is removed. */
  async retainOnly(mediaIds: string[]) {
    if (!hasCache()) return;
    try {
      const cache = await caches.open(CACHE);
      const keep = new Set(mediaIds.map(keyFor));
      for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
    } catch {
      /* ignore */
    }
  },
  async clear() {
    if (hasCache()) await caches.delete(CACHE).catch(() => false);
  },
};

export function uuid(): string {
  const c = window.crypto as Crypto & { randomUUID?: () => string };
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
