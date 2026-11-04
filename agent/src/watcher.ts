import { PublicKey, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { chainNow, formatSol, ixRelease, parseAttemptEvents, readGame, sendIx, signatureStatus, GRACE_SEC, type Chainish } from './chain.js';
import { getAttempt, getMeta, setMeta, type Db } from './db.js';
import { JudgeAborted, type Judge } from './judge.js';
import { preview, type EventLog, type EmitInput } from './events.js';

export interface WatcherOpts {
  db: Db;
  chain: Chainish;
  judge: Judge;
  messageTimeoutSec: number;
  judgingSafetySec: number;
  pollMs: number;
  /** Model id and prompt hash, for public log lines. */
  model?: string;
  promptHash?: string;
  events?: EventLog;
  log?: (m: string) => void;
}

const K_SIG = 'last_indexed_sig';
const K_NEXT = 'next_attempt_id';
const PAGE = 1000;

/**
 * Two loops in one: an indexer that copies confirmed AttemptSubmitted events into Postgres from a
 * stored signature cursor on the game account, and a processor that judges attempts strictly in id order, one at a time.
 */
export class Watcher {
  private stopped = false;
  private lastStatusAt = 0;
  private lastError = '';
  private log: (m: string) => void;
  constructor(private o: WatcherOpts) {
    this.log = o.log ?? ((m) => console.log(m));
  }

  private emit(e: EmitInput) {
    return this.o.events ? this.o.events.emit(e) : Promise.resolve();
  }

  // ─── Indexer ──────────────────────────────────────────────────────────────

  /** Index confirmed transactions on the game account. Returns the number of new events stored. */
  async indexOnce(): Promise<number> {
    const { db, chain } = this.o;
    const until = (await getMeta(db, K_SIG)) ?? undefined;
    // getSignaturesForAddress pages newest-first; walk back to the cursor, then process oldest-first.
    const sigs: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await chain.connection.getSignaturesForAddress(chain.game, { until, before, limit: PAGE }, chain.commitment);
      sigs.push(...page);
      if (page.length < PAGE) break;
      before = page[page.length - 1]!.signature;
    }
    sigs.reverse();
    let count = 0;
    for (const s of sigs) {
      if (!s.err) {
        const tx = await chain.connection.getTransaction(s.signature, { commitment: chain.commitment, maxSupportedTransactionVersion: 0 });
        if (!tx) throw new Error(`transaction ${s.signature} not found yet`); // retry next tick, cursor unchanged
        const ts = BigInt(tx.blockTime ?? s.blockTime ?? Math.floor(Date.now() / 1000));
        for (const a of parseAttemptEvents(tx.meta?.logMessages ?? [], chain.programId)) {
          if (!a.game.equals(chain.game)) continue;
          const prev = await db.query<{ indexed: boolean }>('SELECT indexed FROM attempts WHERE id = $1', [a.id.toString()]);
          const isNew = !prev.rows[0]?.indexed;
          // Upsert. If an unconfirmed POST stored a message against a different hash, drop it.
          await db.query(
            `INSERT INTO attempts (id, game, sender, msg_hash, fee_lamports, pot_after_lamports, attempt_ts, slot, tx_sig, indexed)
             VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8,$9,true)
             ON CONFLICT (id) DO UPDATE SET
               sender = EXCLUDED.sender, fee_lamports = EXCLUDED.fee_lamports, pot_after_lamports = EXCLUDED.pot_after_lamports,
               attempt_ts = EXCLUDED.attempt_ts, slot = EXCLUDED.slot, tx_sig = EXCLUDED.tx_sig, indexed = true,
               message = CASE WHEN attempts.msg_hash = EXCLUDED.msg_hash THEN attempts.message ELSE NULL END,
               message_at = CASE WHEN attempts.msg_hash = EXCLUDED.msg_hash THEN attempts.message_at ELSE NULL END,
               msg_hash = EXCLUDED.msg_hash, updated_at = now()`,
            [a.id.toString(), chain.game.toBase58(), a.sender.toBase58(), a.msgHash, a.feePaid.toString(), a.pot.toString(), Number(ts), tx.slot.toString(), s.signature],
          );
          count++;
          if (isNew) {
            await this.emit({
              kind: 'attempt_seen',
              attemptId: a.id,
              txSig: s.signature,
              text: `Attempt #${a.id} from ${a.sender.toBase58()} paid ${formatSol(a.feePaid)} SOL (pot ${formatSol(a.pot)} SOL)`,
            });
          }
        }
      }
      await setMeta(db, K_SIG, s.signature);
    }
    if (count) this.log(`[index] +${count} attempts`);
    return count;
  }

  // ─── Processor ────────────────────────────────────────────────────────────

  private async nextId(): Promise<bigint> {
    return BigInt((await getMeta(this.o.db, K_NEXT)) ?? '1');
  }

  /**
   * Process at most one attempt. Returns a short status string (for tests and logs):
   * 'idle' | 'waiting_message' | 'judged:<verdict>' | 'no_message' | 'won' | 'closed' | ...
   */
  async processOnce(): Promise<string> {
    const { db, chain } = this.o;
    const id = await this.nextId();
    const row = await getAttempt(db, id);
    if (!row || !row.indexed) {
      // Nothing confirmed to judge. If the game is won, later attempts cannot exist anyway.
      return 'idle';
    }

    // Resume a release that was decided but not confirmed before a restart.
    if (row.verdict === 'approved') return this.finishRelease(id);
    if (row.verdict) {
      await setMeta(db, K_NEXT, (id + 1n).toString());
      return `skip:${row.verdict}`;
    }

    const game = await readGame(chain);
    if (game.won) {
      await this.close(id, 'game_won');
      return 'won';
    }
    const now = chainNow();
    const deadline = game.endTime + GRACE_SEC - BigInt(this.o.judgingSafetySec);
    if (game.finalized || now >= deadline) {
      await this.close(id, 'judging_closed');
      return 'closed';
    }

    if (row.message === null) {
      const age = now - BigInt(Math.floor(row.attempt_ts.getTime() / 1000));
      if (age < BigInt(this.o.messageTimeoutSec)) return 'waiting_message';
      const r = await db.query(
        `UPDATE attempts SET verdict = 'no_message', judged_at = now(), updated_at = now()
         WHERE id = $1 AND message IS NULL AND verdict IS NULL`,
        [id.toString()],
      );
      if (r.rowCount === 1) {
        await setMeta(db, K_NEXT, (id + 1n).toString());
        this.log(`[judge] #${id} no_message`);
        await this.emit({ level: 'warn', kind: 'no_message', attemptId: id, text: `No message for attempt #${id} within ${this.o.messageTimeoutSec}s of the tx; skipped` });
        return 'no_message';
      }
      return 'waiting_message'; // message raced in; judge next tick
    }

    this.log(`[judge] #${id} judging (${row.message.length} chars)`);
    await this.emit({
      kind: 'judge_start',
      attemptId: id,
      text: `Sent #${id} to Claudette (${this.o.model ?? 'model'}, prompt sha256 ${(this.o.promptHash ?? '').slice(0, 16)}…): "${preview(row.message)}"`,
    });
    let result;
    try {
      result = await this.o.judge.judge(row.message);
    } catch (e) {
      if (e instanceof JudgeAborted) return 'aborted';
      throw e;
    }
    await db.query(
      `UPDATE attempts SET verdict = $2, reply = $3, model = $4, prompt_hash = $5, raw_response = $6, judged_at = now(),
         release_status = CASE WHEN $2 = 'approved' THEN 'pending' ELSE NULL END, updated_at = now()
       WHERE id = $1`,
      [id.toString(), result.verdict, result.reply, result.model, result.promptHash, JSON.stringify(result.raw)],
    );
    this.log(`[judge] #${id} ${result.verdict}: ${result.reply}`);
    const label = result.verdict === 'approved' ? 'APPROVED' : result.verdict === 'refused' ? 'REFUSED (kept the pot)' : 'REJECTED';
    await this.emit({
      level: result.verdict === 'approved' ? 'warn' : 'info',
      kind: 'verdict',
      attemptId: id,
      text: `#${id} ${label}: ${preview(result.reply, 160)}`,
    });
    if (result.verdict === 'approved') return this.finishRelease(id);
    await setMeta(db, K_NEXT, (id + 1n).toString());
    return `judged:${result.verdict}`;
  }

  /** Mark this and every later stored attempt as unjudgeable; nothing more will be judged. */
  private async close(id: bigint, verdict: string) {
    await this.o.db.query(`UPDATE attempts SET verdict = $2, judged_at = now(), updated_at = now() WHERE id >= $1 AND verdict IS NULL`, [id.toString(), verdict]);
    const { rows } = await this.o.db.query<{ m: string | null }>('SELECT max(id)::text AS m FROM attempts');
    const max = rows[0]?.m ? BigInt(rows[0].m) : id;
    await setMeta(this.o.db, K_NEXT, ((max >= id ? max : id) + 1n).toString());
  }

  /** Send release(id) with the agent key (idempotent across restarts). */
  private async finishRelease(id: bigint): Promise<string> {
    const { db, chain } = this.o;
    const row = (await getAttempt(db, id))!;
    if (row.release_status === 'confirmed') {
      await setMeta(db, K_NEXT, (id + 1n).toString());
      return 'released';
    }
    if (!chain.agent) throw new Error('approved but no AGENT key configured; cannot release');

    // If a previous run already landed the tx, adopt it.
    if (row.release_tx_sig && (await signatureStatus(chain, row.release_tx_sig)) === 'success') return this.markReleased(id, row.release_tx_sig);
    const game = await readGame(chain);
    if (game.won) {
      // Won by this attempt via an unrecorded tx (only the agent can release).
      await db.query(`UPDATE attempts SET release_status = 'confirmed', release_error = 'won already set on chain', updated_at = now() WHERE id = $1`, [id.toString()]);
      await setMeta(db, K_NEXT, (id + 1n).toString());
      return 'released';
    }

    try {
      const ix = ixRelease(chain.programId, chain.game, chain.agent.publicKey, new PublicKey(row.sender), id);
      const sig = await sendIx(chain, chain.agent, [ix], {
        onSent: async (s) => {
          await db.query(`UPDATE attempts SET release_status = 'sent', release_tx_sig = $2, updated_at = now() WHERE id = $1`, [id.toString(), s]);
          this.log(`[release] #${id} sent ${s}`);
          await this.emit({ kind: 'release_sent', attemptId: id, txSig: s, text: `release(${id}) sent` });
        },
      });
      return this.markReleased(id, sig);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      await db.query(`UPDATE attempts SET release_status = 'error', release_error = $2, updated_at = now() WHERE id = $1`, [id.toString(), msg]);
      this.log(`[release] #${id} failed: ${msg}`);
      await this.emit({ level: 'error', kind: 'release_error', attemptId: id, text: `release(${id}) failed: ${preview(msg, 200)}` });
      if (/JudgingClosed|GameFinalized/.test(msg)) {
        await setMeta(db, K_NEXT, (id + 1n).toString());
        return 'release_closed';
      }
      return 'release_retry';
    }
  }

  private async markReleased(id: bigint, sig: string): Promise<string> {
    await this.o.db.query(`UPDATE attempts SET release_status = 'confirmed', release_tx_sig = $2, release_error = NULL, updated_at = now() WHERE id = $1`, [id.toString(), sig]);
    await setMeta(this.o.db, K_NEXT, (id + 1n).toString());
    this.log(`[release] #${id} confirmed ${sig}`);
    await this.emit({ kind: 'release_confirmed', attemptId: id, txSig: sig, text: `Pot released to the sender of attempt #${id}. Claudette was beaten.` });
    return 'released';
  }

  // ─── Game status announcements (each once, remembered in meta) ────────────

  async announceStart(): Promise<void> {
    const { chain } = this.o;
    const cursor = await getMeta(this.o.db, K_SIG);
    await this.emit({
      kind: 'watcher_started',
      text: `Watcher started: program ${chain.programId.toBase58()}, game ${chain.game.toBase58()} on ${chain.cluster}${cursor ? `, resuming after ${cursor.slice(0, 12)}…` : ''}`,
    });
  }

  async checkGameStatus(): Promise<void> {
    const { db, chain } = this.o;
    const g = await readGame(chain);
    const now = chainNow();
    const once = async (key: string, e: EmitInput) => {
      if (await getMeta(db, key)) return;
      await setMeta(db, key, '1');
      await this.emit(e);
    };
    if (g.won) await once('announced_won', { level: 'warn', kind: 'game_won', text: `Game over: the pot was won.` });
    if (now >= g.endTime) await once('announced_ended', { kind: 'game_ended', text: `Attempts closed at endTime ${g.endTime}. Judging continues until endTime + 1h for pending attempts.` });
    if (g.finalized) {
      await once('announced_finalized', {
        kind: 'game_finalized',
        text: `Game finalized with no winner: pot ${formatSol(g.finalPot)} SOL split; ${formatSol(g.perAttempt)} SOL per attempt, last player bonus ${formatSol(g.lastPlayerBonus)} SOL`,
      });
    } else if (!g.won && now >= g.endTime + GRACE_SEC) {
      await once('announced_finalizable', { kind: 'game_finalizable', text: `Judging window closed. Anyone can now call finalize to split the pot.` });
    }
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    await this.announceStart().catch((e) => this.log(`[watcher] start announce failed: ${String(e)}`));
    while (!this.stopped) {
      try {
        await this.indexOnce();
        // Game-status announcements are not time-critical; check about once a minute to save RPC credits.
        if (Date.now() - this.lastStatusAt >= 60_000) {
          await this.checkGameStatus();
          this.lastStatusAt = Date.now();
        }
        // Drain as many attempts as are ready before sleeping.
        for (let i = 0; i < 50 && !this.stopped; i++) {
          const s = await this.processOnce();
          if (s === 'idle' || s === 'waiting_message' || s === 'release_retry' || s === 'aborted') break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`[watcher] error: ${msg}`);
        if (msg !== this.lastError) {
          this.lastError = msg; // don't flood the public log with a repeating RPC error
          await this.emit({ level: 'error', kind: 'watcher_error', text: `Watcher error: ${preview(msg, 200)}` }).catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, this.o.pollMs));
    }
  }

  stop() {
    this.stopped = true;
  }
}
