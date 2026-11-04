export type Verdict = 'approved' | 'rejected' | 'refused' | 'pending' | 'awaiting_message' | (string & {});

export interface Attempt {
  id: number;
  sender: string;
  msgHash: string;
  feeLamports: string;
  fee: string;
  potAfterLamports?: string | null;
  txSig: string | null;
  slot?: number | null;
  confirmed?: boolean;
  message: string | null;
  verdict: Verdict;
  reply: string | null;
  model?: string | null;
  promptHash?: string | null;
  releaseTxSig?: string | null;
  releaseStatus?: string | null;
  attemptAt: string;
  messageAt?: string | null;
  judgedAt?: string | null;
  /** Optional: backend may pick a face. Otherwise derived from verdict. */
  expression?: string | null;
}

export interface GameState {
  cluster: string;
  programId: string;
  game: string;
  gameId: number;
  treasury: string;
  model: string;
  promptHash: string;
  potLamports: string;
  pot: string;
  currentFeeLamports: string;
  currentFee: string;
  maxFeeLamports: string;
  endTime: number;
  timeLeft: number;
  judgingEndsAt: number;
  totalAttempts: number;
  lastPlayer: string | null;
  won: boolean;
  winner: { attemptId: number; address: string; releaseTxSig: string | null; reply: string | null } | null;
  finalized: boolean;
  finalizable: boolean;
  finalize: { finalPotLamports: string; lastPlayerBonusLamports: string; perAttemptLamports: string; claimDeadline: number; swept: boolean } | null;
  messageTimeoutSec: number;
}

export interface AttemptsPage {
  items: Attempt[];
  nextCursor: string | number | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | (string & {});

export interface LogEvent {
  id?: string | number;
  ts: string | number;
  level: LogLevel;
  kind: string;
  attemptId?: number | null;
  text: string;
  txSig?: string | null;
}
