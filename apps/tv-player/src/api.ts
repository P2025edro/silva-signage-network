declare const __API_URL__: string;

/** API base: ?api= query parameter, then build-time setting, then same origin. */
export const API_BASE = (() => {
  try {
    const fromQuery = new URLSearchParams(location.search).get('api');
    if (fromQuery && /^https?:\/\//.test(fromQuery)) return fromQuery.replace(/\/$/, '');
  } catch {
    /* old browsers without URLSearchParams fall through */
  }
  return (__API_URL__ || '').replace(/\/$/, '');
})();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

export async function call<T>(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), opts.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'omit',
      signal: controller?.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR');
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}
