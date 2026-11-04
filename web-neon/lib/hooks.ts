'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, subscribeLogs } from './api';
import type { LogEvent } from './types';

export function useGameState() {
  return useQuery({ queryKey: ['state'], queryFn: api.state, refetchInterval: 5000 });
}

export function useLatestAttempts() {
  return useQuery({ queryKey: ['attempts', 'head'], queryFn: () => api.attempts(null), refetchInterval: 5000 });
}

/** Approximate SOL/USD. Optional: returns null if the price API is unreachable. */
export function useSolUsd() {
  return useQuery({
    queryKey: ['solusd'],
    queryFn: async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (!r.ok) throw new Error('price');
      const j = (await r.json()) as { solana?: { usd?: number } };
      return j.solana?.usd ?? null;
    },
    refetchInterval: 120_000,
    retry: 0,
    staleTime: 60_000,
  });
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const MAX_LINES = 400;

export function useLogStream() {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>('connecting');
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    const key = (e: LogEvent) => String(e.id ?? `${e.ts}|${e.kind}|${e.text}`);
    const push = (evs: LogEvent[]) => {
      const fresh = evs.filter((e) => {
        const k = key(e);
        if (seen.current.has(k)) return false;
        seen.current.add(k);
        return true;
      });
      if (!fresh.length) return;
      setLines((prev) => [...prev, ...fresh].slice(-MAX_LINES));
    };
    api
      .logs(200)
      .then((b) => alive && push(b))
      .catch(() => {});
    const off = subscribeLogs(
      (e) => alive && push([e]),
      (s) => alive && setStatus(s),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  return { lines, status };
}
