import { API_URL, MOCK } from './config';
import { mockApi } from './mock';
import type { Attempt, AttemptsPage, GameState, LogEvent } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_URL) throw new ApiError('NEXT_PUBLIC_API_URL is not set', 0);
  const r = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, cache: 'no-store' });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* non-JSON */
  }
  if (!r.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
    throw new ApiError(msg, r.status);
  }
  return body as T;
}

export const api = {
  state: (): Promise<GameState> => (MOCK ? mockApi.state() : j('/state')),
  attempts: (cursor?: string | number | null): Promise<AttemptsPage> =>
    MOCK ? mockApi.attempts(cursor) : j(`/attempts${cursor ? `?cursor=${encodeURIComponent(String(cursor))}` : ''}`),
  attempt: (id: number): Promise<Attempt> => (MOCK ? mockApi.attempt(id) : j(`/attempts/${id}`)),
  postAttempt: (signature: string, message: string): Promise<{ ok: boolean; duplicate?: boolean; attempt: Attempt }> =>
    MOCK ? mockApi.postAttempt(signature, message) : j('/attempt', { method: 'POST', body: JSON.stringify({ signature, message }) }),
  async logs(limit = 200): Promise<LogEvent[]> {
    if (MOCK) return mockApi.logs(limit);
    const body = await j<LogEvent[] | { items: LogEvent[] }>(`/logs?limit=${limit}`);
    const items = Array.isArray(body) ? body : body.items ?? [];
    // Oldest first for the terminal.
    return [...items].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  },
};

/** Subscribe to the live log. Returns an unsubscribe function. */
export function subscribeLogs(onEvent: (e: LogEvent) => void, onStatus: (s: 'live' | 'reconnecting' | 'offline') => void) {
  if (MOCK) {
    onStatus('live');
    return mockApi.subscribe(onEvent);
  }
  if (!API_URL || typeof EventSource === 'undefined') {
    onStatus('offline');
    return () => {};
  }
  const es = new EventSource(`${API_URL}/logs/stream`);
  const handle = (m: MessageEvent) => {
    try {
      const e = JSON.parse(m.data) as LogEvent;
      if (e && typeof e.text === 'string') onEvent(e);
    } catch {
      /* ignore keepalives / malformed lines */
    }
  };
  es.onmessage = handle;
  es.addEventListener('log', handle as EventListener);
  es.onopen = () => onStatus('live');
  es.onerror = () => onStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
  return () => es.close();
}
