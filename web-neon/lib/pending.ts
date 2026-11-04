/** A message the player paid for but the backend may not have received yet. */
export interface PendingMessage {
  attemptId?: number;
  /** Payment transaction signature (base58). */
  txSig?: string;
  message: string;
  msgHash: string;
  sender?: string;
  createdAt: number;
  posted?: boolean;
}

const KEY = 'claudette:pending:sol:v1';

export function loadPending(): PendingMessage | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingMessage;
    if (typeof p?.message !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

export function savePending(p: PendingMessage) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the flow still works without refresh recovery */
  }
}

export function clearPending() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
