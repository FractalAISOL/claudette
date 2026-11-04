import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { chainNow, formatSol, CLAIM_WINDOW_SEC, messageHash, readAttemptTx, readGame, GRACE_SEC, type Chainish } from './chain.js';
import { getAttempt, type AttemptRow, type Db } from './db.js';
import { preview, type EventLog, type LogEvent } from './events.js';

export interface ServerOpts {
  db: Db;
  chain: Chainish;
  messageTimeoutSec: number;
  promptHash: string;
  model: string;
  events: EventLog;
  /** SSE keepalive interval (ms). */
  pingMs?: number;
}

const MAX_CHARS = 1000;

function publicAttempt(r: AttemptRow, full = false) {
  return {
    id: Number(r.id),
    sender: r.sender,
    msgHash: r.msg_hash,
    feeLamports: r.fee_lamports,
    fee: formatSol(BigInt(r.fee_lamports)),
    potAfterLamports: r.pot_after_lamports,
    txSig: r.tx_sig,
    slot: r.slot ? Number(r.slot) : null,
    confirmed: r.indexed,
    message: r.message,
    verdict: r.verdict ?? (r.message ? 'pending' : 'awaiting_message'),
    reply: r.reply,
    model: r.model,
    promptHash: r.prompt_hash,
    releaseTxSig: r.release_tx_sig,
    releaseStatus: r.release_status,
    attemptAt: r.attempt_ts.toISOString(),
    messageAt: r.message_at?.toISOString() ?? null,
    judgedAt: r.judged_at?.toISOString() ?? null,
    ...(full ? { rawResponse: r.raw_response } : {}),
  };
}

export function makeApp(o: ServerOpts) {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }));

  app.get('/health', (c) => c.json({ ok: true }));

  // Cache /state so a busy website costs at most one RPC read per 10 s.
  let stateCache: { at: number; body: unknown } | null = null;
  app.get('/state', async (c) => {
    if (stateCache && Date.now() - stateCache.at < 10_000) return c.json(stateCache.body);
    const g = await readGame(o.chain);
    const now = chainNow();
    const { rows } = await o.db.query<{ id: string; sender: string; release_tx_sig: string | null; reply: string | null }>(
      `SELECT id, sender, release_tx_sig, reply FROM attempts WHERE verdict = 'approved' ORDER BY id LIMIT 1`,
    );
    const w = rows[0];
    const judgingEnds = g.endTime + GRACE_SEC;
    const body = {
      cluster: o.chain.cluster,
      programId: o.chain.programId.toBase58(),
      game: o.chain.game.toBase58(),
      gameId: Number(g.gameId),
      treasury: g.treasury.toBase58(),
      model: o.model,
      promptHash: o.promptHash,
      potLamports: g.pot.toString(),
      pot: formatSol(g.pot),
      currentFeeLamports: g.currentFee.toString(),
      currentFee: formatSol(g.currentFee),
      maxFeeLamports: g.maxFee.toString(),
      endTime: Number(g.endTime),
      timeLeft: Number(g.timeLeft),
      judgingEndsAt: Number(judgingEnds),
      totalAttempts: Number(g.totalAttempts),
      lastPlayer: g.totalAttempts > 0n ? g.lastPlayer.toBase58() : null,
      won: g.won,
      winner: w ? { attemptId: Number(w.id), address: w.sender, releaseTxSig: w.release_tx_sig, reply: w.reply } : null,
      finalized: g.finalized,
      finalizable: !g.won && !g.finalized && now >= judgingEnds,
      finalize: g.finalized
        ? {
            finalPotLamports: g.finalPot.toString(),
            lastPlayerBonusLamports: g.lastPlayerBonus.toString(),
            perAttemptLamports: g.perAttempt.toString(),
            claimDeadline: Number(g.doneAt + CLAIM_WINDOW_SEC),
            swept: g.swept,
          }
        : null,
      messageTimeoutSec: o.messageTimeoutSec,
    };
    stateCache = { at: Date.now(), body };
    return c.json(body);
  });

  app.post('/attempt', async (c) => {
    let body: { signature?: unknown; message?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const signature = body.signature;
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) {
      return c.json({ error: 'signature must be a base58 transaction signature' }, 400);
    }
    const message = body.message;
    if (typeof message !== 'string') return c.json({ error: 'message must be a string' }, 400);
    const chars = [...message].length;
    if (chars < 1 || chars > MAX_CHARS) return c.json({ error: `message must be 1..${MAX_CHARS} characters` }, 400);
    if (message.trim().length === 0) return c.json({ error: 'message is blank' }, 400);

    const onchain = await readAttemptTx(o.chain, signature);
    if (!onchain) return c.json({ error: 'attempt not found on chain (yet)' }, 404);
    const id = onchain.id;
    const hash = messageHash(message);
    if (hash !== onchain.msgHash) {
      await o.events.emit({ level: 'warn', kind: 'hash_mismatch', attemptId: id, text: `Message for #${id} rejected: sha256 does not match the on-chain msg_hash` });
      return c.json({ error: 'message does not match on-chain msg_hash', expected: onchain.msgHash, got: hash }, 400);
    }
    if (chainNow() - onchain.timestamp >= BigInt(o.messageTimeoutSec)) {
      return c.json({ error: `message window closed (${o.messageTimeoutSec}s after the attempt tx)` }, 410);
    }

    // Insert the row if the indexer hasn't seen it yet (unconfirmed; the indexer will confirm or fix it).
    await o.db.query(
      `INSERT INTO attempts (id, game, sender, msg_hash, fee_lamports, attempt_ts, slot, tx_sig, indexed)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6),$7,$8,false) ON CONFLICT (id) DO NOTHING`,
      [id.toString(), o.chain.game.toBase58(), onchain.sender.toBase58(), onchain.msgHash, onchain.feePaid.toString(), Number(onchain.timestamp), onchain.slot.toString(), signature],
    );
    const r = await o.db.query(
      `UPDATE attempts SET message = $2, message_at = now(), updated_at = now()
       WHERE id = $1 AND message IS NULL AND verdict IS NULL AND msg_hash = $3`,
      [id.toString(), message, hash],
    );
    const row = (await getAttempt(o.db, id))!;
    if (r.rowCount === 0) {
      if (row.message === message) return c.json({ ok: true, duplicate: true, attempt: publicAttempt(row) });
      if (row.verdict) return c.json({ error: `attempt already closed (${row.verdict})` }, 409);
      return c.json({ error: 'attempt state conflict' }, 409);
    }
    await o.events.emit({ kind: 'message_received', attemptId: id, text: `Message for #${id} received, hash verified: "${preview(message)}"` });
    return c.json({ ok: true, attempt: publicAttempt(row) });
  });

  app.get('/logs', async (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    return c.json({ items: await o.events.recent(limit) });
  });

  app.get('/logs/stream', (c) => {
    const lastId = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? NaN);
    return streamSSE(c, async (stream) => {
      const queue: LogEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = o.events.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const send = (e: LogEvent) => stream.writeSSE({ id: String(e.id), event: 'log', data: JSON.stringify(e) });
      let sent = 0;
      try {
        // Replay what the client missed (reconnect) or a recent tail (first connect).
        const backlog = Number.isFinite(lastId) ? await o.events.after(lastId) : await o.events.recent(Math.min(1000, Number(c.req.query('tail') ?? 50) || 50));
        for (const e of backlog) {
          await send(e);
          sent = Math.max(sent, e.id);
        }
        const ping = setInterval(() => {
          void stream.writeSSE({ event: 'ping', data: JSON.stringify({ ts: new Date().toISOString() }) }).catch(() => {});
        }, o.pingMs ?? 15_000);
        try {
          while (!closed) {
            while (queue.length) {
              const e = queue.shift()!;
              if (e.id <= sent) continue;
              await send(e);
              sent = e.id;
            }
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        } finally {
          clearInterval(ping);
        }
      } finally {
        unsub();
      }
    });
  });

  app.get('/attempts', async (c) => {
    const cursor = c.req.query('cursor');
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    if (cursor !== undefined && !/^\d{1,19}$/.test(cursor)) return c.json({ error: 'bad cursor' }, 400);
    const { rows } = cursor
      ? await o.db.query<AttemptRow>('SELECT * FROM attempts WHERE id < $1 ORDER BY id DESC LIMIT $2', [cursor, limit])
      : await o.db.query<AttemptRow>('SELECT * FROM attempts ORDER BY id DESC LIMIT $1', [limit]);
    const items = rows.map((r) => publicAttempt(r));
    const last = rows[rows.length - 1];
    return c.json({ items, nextCursor: rows.length === limit && last ? last.id : null });
  });

  app.get('/attempts/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[1-9]\d{0,18}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const row = await getAttempt(o.db, BigInt(id));
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(publicAttempt(row, true));
  });

  app.onError((err, c) => {
    console.error('[http]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
