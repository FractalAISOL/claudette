import { EventEmitter } from 'node:events';
import type { Db } from './db.js';

export type Level = 'info' | 'warn' | 'error';

export interface LogEvent {
  id: number;
  ts: string;
  level: Level;
  kind: string;
  attemptId?: number;
  text: string;
  txSig?: string;
}

export interface EmitInput {
  level?: Level;
  kind: string;
  attemptId?: bigint | number;
  text: string;
  txSig?: string;
}

/** Short, single-line preview of untrusted text for public log lines (max 60 chars). */
export function preview(s: string, max = 60): string {
  const flat = s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : flat;
}

interface Row {
  id: string;
  ts: Date;
  level: Level;
  kind: string;
  attempt_id: string | null;
  text: string;
  tx_sig: string | null;
}

function toEvent(r: Row): LogEvent {
  return {
    id: Number(r.id),
    ts: r.ts.toISOString(),
    level: r.level,
    kind: r.kind,
    ...(r.attempt_id !== null ? { attemptId: Number(r.attempt_id) } : {}),
    text: r.text,
    ...(r.tx_sig ? { txSig: r.tx_sig } : {}),
  };
}

/**
 * Public, persisted event log. Everything written here is world-readable via /logs and
 * /logs/stream: never pass secrets, raw API responses, or full message text.
 */
export class EventLog {
  private bus = new EventEmitter();
  constructor(private db: Db, private echo = true) {
    this.bus.setMaxListeners(0);
  }

  async emit(e: EmitInput): Promise<void> {
    const level = e.level ?? 'info';
    const text = e.text.slice(0, 500);
    if (this.echo) (level === 'info' ? console.log : console.warn)(`[${e.kind}]${e.attemptId !== undefined ? ` #${e.attemptId}` : ''} ${text}`);
    try {
      const { rows } = await this.db.query<Row>(
        `INSERT INTO events (level, kind, attempt_id, text, tx_sig) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [level, e.kind, e.attemptId === undefined ? null : e.attemptId.toString(), text, e.txSig ?? null],
      );
      this.bus.emit('event', toEvent(rows[0]!));
    } catch (err) {
      console.error('[events] failed to persist event', err);
    }
  }

  /** Newest `limit` events, returned oldest-first. */
  async recent(limit: number): Promise<LogEvent[]> {
    const { rows } = await this.db.query<Row>('SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT $1) t ORDER BY id ASC', [limit]);
    return rows.map(toEvent);
  }

  async after(id: number, limit = 500): Promise<LogEvent[]> {
    const { rows } = await this.db.query<Row>('SELECT * FROM events WHERE id > $1 ORDER BY id ASC LIMIT $2', [id, limit]);
    return rows.map(toEvent);
  }

  subscribe(fn: (e: LogEvent) => void): () => void {
    this.bus.on('event', fn);
    return () => this.bus.off('event', fn);
  }
}
