import pg from 'pg';

export type Db = pg.Pool;

export function makeDb(url: string): Db {
  const ssl = /sslmode=require/.test(url) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString: url, ssl, max: 10 });
}

// Append-only list. Each entry runs once, in order, inside a transaction.
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   text PRIMARY KEY,
     value text NOT NULL
   );
   CREATE TABLE IF NOT EXISTS attempts (
     id               bigint PRIMARY KEY,
     game             text NOT NULL,
     sender           text NOT NULL,
     msg_hash         text NOT NULL,
     fee_lamports     numeric(20,0) NOT NULL,
     pot_after_lamports numeric(20,0),
     attempt_ts       timestamptz NOT NULL,
     slot             bigint,
     tx_sig           text,
     indexed          boolean NOT NULL DEFAULT false,
     message          text,
     message_at       timestamptz,
     verdict          text,
     reply            text,
     model            text,
     prompt_hash      text,
     raw_response     jsonb,
     judged_at        timestamptz,
     release_status   text,
     release_tx_sig   text,
     release_error    text,
     created_at       timestamptz NOT NULL DEFAULT now(),
     updated_at       timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS attempts_verdict_idx ON attempts (verdict);`,
  `CREATE TABLE IF NOT EXISTS events (
     id         bigserial PRIMARY KEY,
     ts         timestamptz NOT NULL DEFAULT now(),
     level      text NOT NULL CHECK (level IN ('info','warn','error')),
     kind       text NOT NULL,
     attempt_id bigint,
     text       text NOT NULL,
     tx_sig     text
   );`,
];

export async function migrate(db: Db): Promise<void> {
  const c = await db.connect();
  try {
    await c.query('SELECT pg_advisory_lock(4663001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await c.query<{ version: number }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (done.has(i + 1)) continue;
      await c.query('BEGIN');
      try {
        await c.query(MIGRATIONS[i]!);
        await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i + 1]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(4663001)').catch(() => {});
    c.release();
  }
}

export async function getMeta(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
}

export interface AttemptRow {
  id: string;
  game: string;
  sender: string;
  msg_hash: string;
  fee_lamports: string;
  pot_after_lamports: string | null;
  attempt_ts: Date;
  slot: string | null;
  tx_sig: string | null;
  indexed: boolean;
  message: string | null;
  message_at: Date | null;
  verdict: string | null;
  reply: string | null;
  model: string | null;
  prompt_hash: string | null;
  raw_response: unknown;
  judged_at: Date | null;
  release_status: string | null;
  release_tx_sig: string | null;
  release_error: string | null;
  created_at: Date;
}

export async function getAttempt(db: Db, id: bigint): Promise<AttemptRow | null> {
  const { rows } = await db.query<AttemptRow>('SELECT * FROM attempts WHERE id = $1', [id.toString()]);
  return rows[0] ?? null;
}
