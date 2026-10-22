/** Thin fetch wrapper. Cookies carry the session; the API enforces every permission. */
const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<T>('POST', path, fd);
  },
};

export const apiUrl = (path: string) => `${BASE}${path}`;

/** Field errors from a 400 VALIDATION_ERROR response, keyed by field path. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as Array<{ path?: Array<string | number>; instancePath?: string; message?: string }>) {
    const key = d.path?.join('.') ?? d.instancePath?.replace(/^\//, '').replace(/\//g, '.') ?? '';
    if (key && d.message) out[key] = d.message;
  }
  return out;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const fields = fieldErrors(e);
    const first = Object.entries(fields)[0];
    return first ? `${e.message}: ${first[0]} — ${first[1]}` : e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}
