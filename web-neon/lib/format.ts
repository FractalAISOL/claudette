export function short(a?: string | null, n = 4) {
  if (!a) return '';
  return `${a.slice(0, n)}…${a.slice(-n)}`;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function lamportsToSol(l: string | bigint | number): number {
  return Number(typeof l === 'bigint' ? l : BigInt(l)) / LAMPORTS_PER_SOL;
}

/** SOL with sensible precision: big numbers get fewer decimals. */
export function sol(lamports: string | bigint | null | undefined, maxDp?: number) {
  if (lamports === null || lamports === undefined || lamports === '') return '0';
  const v = lamportsToSol(lamports);
  const dp = maxDp ?? (v >= 100 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 4 : 6);
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, dp), maximumFractionDigits: dp });
}

export function usd(v: number) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v >= 1000 ? 0 : 2 });
}

export function tsToDate(ts: string | number) {
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts);
  const n = Number(ts);
  if (!Number.isNaN(n) && /^\d+$/.test(ts)) return new Date(n < 1e12 ? n * 1000 : n);
  return new Date(ts);
}

export function clock(ts: string | number) {
  const d = tsToDate(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - tsToDate(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function countdownParts(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
