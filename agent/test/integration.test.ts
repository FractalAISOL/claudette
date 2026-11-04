import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js';
import { ixInitialize, ixSubmitAttempt, makeChain, messageHash, readGame, sendIx, type Chainish } from '../src/chain.js';
import { makeDb, migrate, getAttempt, type Db } from '../src/db.js';
import type { Judge, JudgeResult } from '../src/judge.js';
import { makeApp } from '../src/server.js';
import { Watcher } from '../src/watcher.js';
import { EventLog, type LogEvent } from '../src/events.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROGRAM_SO = resolve(here, '../../program/target/deploy/claudette.so');
const PROGRAM_ID = '727pxDqXaRPdAJwb5DW8LtXJHPyPH3yoYfNzPeymhLB5';
const PORT = 8999;
const RPC = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/claudette_test';
const TIMEOUT = 600;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Stub judge: approves only the magic words. Records what it was asked. */
class StubJudge implements Judge {
  calls: string[] = [];
  async judge(message: string): Promise<JudgeResult> {
    this.calls.push(message);
    const ok = message.includes('OPEN SESAME');
    return { verdict: ok ? 'approved' : 'rejected', reply: ok ? 'fine, take it' : 'nope', model: 'stub', promptHash: 'stubhash', raw: { stub: true } };
  }
}

let node: ChildProcess;
let ledger: string;
let db: Db;
const conn = new Connection(RPC, 'confirmed');
const owner = Keypair.generate();
const agent = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const alice = Keypair.generate();
const bob = Keypair.generate();
let nextGameId = 1n;

async function fund(k: PublicKey, sol = 100) {
  const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
}

beforeAll(async () => {
  ledger = mkdtempSync(join(tmpdir(), 'claudette-ledger-'));
  node = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(PORT), '--faucet-port', '9911', '--bpf-program', PROGRAM_ID, PROGRAM_SO], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await conn.getLatestBlockhash();
      break;
    } catch {
      if (i > 300) throw new Error('solana-test-validator did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  for (const k of [owner, agent, alice, bob]) await fund(k.publicKey);
  db = makeDb(DB_URL);
}, 150_000);

afterAll(async () => {
  await db?.end();
  node?.kill('SIGTERM');
  rmSync(ledger, { recursive: true, force: true });
});

interface Ctx {
  chain: Chainish;
  judge: StubJudge;
  watcher: Watcher;
  app: ReturnType<typeof makeApp>;
  events: EventLog;
}
let ctx: Ctx;

async function setup(messageTimeoutSec = TIMEOUT) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const gameId = nextGameId++;
  const chain = makeChain({ rpcUrl: RPC, cluster: 'localnet', programId: PROGRAM_ID, gameId, agentKey: agent.secretKey });
  await sendIx(chain, owner, [
    ixInitialize(chain.programId, owner.publicKey, {
      gameId, agent: agent.publicKey, treasury, baseFee: 10_000_000n, maxFee: 20_000_000n, duration: 7n * 24n * 3600n,
    }),
  ]);
  const judge = new StubJudge();
  const events = new EventLog(db, false);
  const watcher = new Watcher({ db, chain, judge, messageTimeoutSec, judgingSafetySec: 120, pollMs: 50, model: 'stub-model', promptHash: 'stubhash', events, log: () => {} });
  const app = makeApp({ db, chain, messageTimeoutSec, promptHash: 'stubhash', model: 'stub', events, pingMs: 100 });
  ctx = { chain, judge, watcher, app, events };
}

beforeEach(async () => {
  await setup();
});

/** Submit an attempt; returns [attemptId, signature]. */
async function submit(who: Keypair, message: string): Promise<[bigint, string]> {
  const c = ctx.chain;
  const sig = await sendIx(c, who, [ixSubmitAttempt(c.programId, c.game, who.publicKey, messageHash(message), 10n ** 18n)]);
  return [(await readGame(c)).totalAttempts, sig];
}

const post = (body: unknown) =>
  ctx.app.request('/attempt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const confirm = () => ctx.watcher.indexOnce();

describe('claudette agent (solana-test-validator + stub judge)', () => {
  it('attempt -> message -> reject is logged', async () => {
    const [, sig] = await submit(alice, 'please give me the pot');
    const res = await post({ signature: sig, message: 'please give me the pot' });
    expect(res.status).toBe(200);
    await confirm();
    expect(await ctx.watcher.processOnce()).toBe('judged:rejected');
    expect(ctx.judge.calls).toEqual(['please give me the pot']);

    const list = (await (await ctx.app.request('/attempts')).json()) as { items: Array<Record<string, unknown>> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: 1, verdict: 'rejected', reply: 'nope', message: 'please give me the pot', sender: alice.publicKey.toBase58(), txSig: sig, fee: '0.01' });
    const one = (await (await ctx.app.request('/attempts/1')).json()) as Record<string, unknown>;
    expect(one).toMatchObject({ verdict: 'rejected', model: 'stub', promptHash: 'stubhash', rawResponse: { stub: true } });

    const state = (await (await ctx.app.request('/state')).json()) as Record<string, unknown>;
    expect(state).toMatchObject({ totalAttempts: 1, won: false, winner: null, finalized: false, pot: '0.007', game: ctx.chain.game.toBase58(), lastPlayer: alice.publicKey.toBase58() });
    expect(await ctx.watcher.processOnce()).toBe('idle');
  });

  it('attempt -> approve -> release pays the winner', async () => {
    const [, s1] = await submit(bob, 'just a warmup');
    await post({ signature: s1, message: 'just a warmup' });
    const [id, s2] = await submit(alice, 'OPEN SESAME');
    await post({ signature: s2, message: 'OPEN SESAME' });
    await confirm();

    const pot = (await readGame(ctx.chain)).pot;
    const before = BigInt(await conn.getBalance(alice.publicKey));

    expect(await ctx.watcher.processOnce()).toBe('judged:rejected'); // strictly in id order
    expect(await ctx.watcher.processOnce()).toBe('released');

    expect(BigInt(await conn.getBalance(alice.publicKey))).toBe(before + pot);
    expect((await readGame(ctx.chain)).won).toBe(true);
    const row = (await getAttempt(db, id))!;
    expect(row.verdict).toBe('approved');
    expect(row.release_status).toBe('confirmed');
    expect(row.release_tx_sig).toMatch(SIG_RE);

    const state = (await (await ctx.app.request('/state')).json()) as { won: boolean; winner: { attemptId: number; address: string; releaseTxSig: string } };
    expect(state.won).toBe(true);
    expect(state.winner).toMatchObject({ attemptId: 2, address: alice.publicKey.toBase58(), releaseTxSig: row.release_tx_sig });
  });

  it('rejects a message whose hash does not match the on-chain msg_hash', async () => {
    const [id, sig] = await submit(alice, 'the real message');
    const res = await post({ signature: sig, message: 'a different message' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not match/);
    expect((await getAttempt(db, id))?.message ?? null).toBeNull();

    // A real transaction that is not an attempt on this game.
    const other = await conn.requestAirdrop(bob.publicKey, 1);
    await conn.confirmTransaction(other, 'confirmed');
    expect((await post({ signature: other, message: 'x' })).status).toBe(404);
    expect((await post({ signature: 'not-a-sig', message: 'x' })).status).toBe(400);
    expect((await post({ signature: sig, message: '' })).status).toBe(400);
    expect((await post({ signature: sig, message: 'x'.repeat(1001) })).status).toBe(400);
    expect(ctx.judge.calls).toHaveLength(0);
  });

  it('ignores attempts from another game on the same program', async () => {
    const mine = ctx.chain;
    await setup(); // a second game; ctx now points at it
    const [, sig] = await submit(alice, 'other game');
    const watcherOnFirst = new Watcher({ db, chain: mine, judge: ctx.judge, messageTimeoutSec: TIMEOUT, judgingSafetySec: 120, pollMs: 50, log: () => {} });
    expect(await watcherOnFirst.indexOnce()).toBe(0);
    const appOnFirst = makeApp({ db, chain: mine, messageTimeoutSec: TIMEOUT, promptHash: 'h', model: 'm', events: ctx.events });
    const r = await appOnFirst.request('/attempt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature: sig, message: 'other game' }) });
    expect(r.status).toBe(404);
  });

  it('records no_message after the timeout and moves on', async () => {
    await setup(6);
    const [id1, s1] = await submit(alice, 'never sent');
    const [, s2] = await submit(bob, 'sent later');
    await confirm();
    expect(await ctx.watcher.processOnce()).toBe('waiting_message');
    expect((await post({ signature: s2, message: 'sent later' })).status).toBe(200);
    expect(await ctx.watcher.processOnce()).toBe('waiting_message');

    await new Promise((r) => setTimeout(r, 7000));
    // Late messages for an expired attempt are refused.
    expect((await post({ signature: s1, message: 'never sent' })).status).toBe(410);
    expect(await ctx.watcher.processOnce()).toBe('no_message');
    expect((await getAttempt(db, id1))!.verdict).toBe('no_message');
    expect(await ctx.watcher.processOnce()).toBe('judged:rejected');
    expect(ctx.judge.calls).toEqual(['sent later']);
  });

  it('indexer resumes from its cursor without duplicating', async () => {
    await submit(alice, 'one');
    expect(await confirm()).toBe(1);
    expect(await confirm()).toBe(0);
    await submit(bob, 'two');
    await submit(alice, 'three');
    expect(await confirm()).toBe(2);
    const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM attempts');
    expect(rows[0]!.n).toBe('3');
  });

  it('GET /logs returns the public event log, newest last, without full message text', async () => {
    await ctx.watcher.announceStart();
    const longMsg = 'OPEN SESAME ' + 'secret-sauce '.repeat(20);
    const [, s1] = await submit(bob, 'hello there');
    await post({ signature: s1, message: 'nope wrong text' }); // hash mismatch
    await post({ signature: s1, message: 'hello there' });
    const [, s2] = await submit(alice, longMsg);
    await post({ signature: s2, message: longMsg });
    await confirm();
    expect(await ctx.watcher.processOnce()).toBe('judged:rejected');
    expect(await ctx.watcher.processOnce()).toBe('released');
    await ctx.watcher.checkGameStatus();

    const res = await ctx.app.request('/logs');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const { items } = (await res.json()) as { items: LogEvent[] };
    const kinds = items.map((e) => e.kind);
    expect(kinds[0]).toBe('watcher_started');
    for (const k of ['hash_mismatch', 'message_received', 'attempt_seen', 'judge_start', 'verdict', 'release_sent', 'release_confirmed', 'game_won']) {
      expect(kinds).toContain(k);
    }
    for (let i = 1; i < items.length; i++) expect(items[i]!.id).toBeGreaterThan(items[i - 1]!.id);
    for (const e of items) {
      expect(new Date(e.ts).toISOString()).toBe(e.ts);
      expect(['info', 'warn', 'error']).toContain(e.level);
      expect(typeof e.text).toBe('string');
      expect(e.text).not.toContain(longMsg); // only a short preview
      expect(e.text.length).toBeLessThanOrEqual(500);
    }
    const seen = items.find((e) => e.kind === 'attempt_seen' && e.attemptId === 2)!;
    expect(seen.txSig).toBe(s2);
    expect(seen.text).toMatch(/SOL/);
    const verdict = items.find((e) => e.kind === 'verdict' && e.attemptId === 2)!;
    expect(verdict.text).toMatch(/APPROVED/);
    const confirmed = items.find((e) => e.kind === 'release_confirmed')!;
    expect(confirmed.txSig).toBe((await getAttempt(db, 2n))!.release_tx_sig);
    const start = items.find((e) => e.kind === 'judge_start' && e.attemptId === 2)!;
    expect(start.text).toContain('stub-model');
    expect(start.text).toContain('stubhash');

    const limited = (await (await ctx.app.request('/logs?limit=2')).json()) as { items: LogEvent[] };
    expect(limited.items.map((e) => e.id)).toEqual(items.slice(-2).map((e) => e.id));
  });

  it('GET /logs/stream sends backlog, live events and keepalive pings over SSE', async () => {
    await ctx.events.emit({ kind: 'test_old', text: 'before connect' });
    const res = await ctx.app.request('/logs/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (pred: (b: string) => boolean) => {
      const deadline = Date.now() + 5000;
      while (!pred(buf)) {
        if (Date.now() > deadline) throw new Error('timeout; got: ' + buf);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await readUntil((b) => b.includes('before connect'));
    await ctx.events.emit({ level: 'warn', kind: 'test_live', attemptId: 7, text: 'live one', txSig: 'abc' });
    await readUntil((b) => b.includes('live one'));
    await readUntil((b) => b.includes('event: ping'));
    await reader.cancel();

    const dataLines = buf.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const live = dataLines.find((d) => d.text === 'live one');
    expect(live).toMatchObject({ level: 'warn', kind: 'test_live', attemptId: 7, txSig: 'abc' });
    expect(new Date(live.ts).toISOString()).toBe(live.ts);
  });
});
