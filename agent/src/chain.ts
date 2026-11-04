import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Commitment,
  type Finality,
} from '@solana/web3.js';

export const GRACE_SEC = 3600n;
/** Shares stay claimable this long after finalize (program CLAIM_WINDOW). */
export const CLAIM_WINDOW_SEC = 30n * 24n * 3600n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

const GAME_SEED = Buffer.from('game');
const PLAYER_SEED = Buffer.from('player');

const disc = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8);
const D = {
  game: disc('account:Game'),
  attemptSubmitted: disc('event:AttemptSubmitted'),
  initialize: disc('global:initialize'),
  submitAttempt: disc('global:submit_attempt'),
  release: disc('global:release'),
  finalize: disc('global:finalize'),
};

export interface Chainish {
  connection: Connection;
  cluster: string;
  programId: PublicKey;
  game: PublicKey;
  gameId: bigint;
  commitment: Finality;
  agent?: Keypair;
  /** Priority fee for agent txs, in micro-lamports per compute unit. */
  priorityMicroLamports: number;
}

export function gamePda(programId: PublicKey, gameId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([GAME_SEED, u64(gameId)], programId)[0];
}

export function playerPda(programId: PublicKey, game: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, game.toBuffer(), wallet.toBuffer()], programId)[0];
}

export function makeChain(opts: {
  rpcUrl: string;
  cluster: string;
  programId: string;
  gameId: bigint;
  commitment?: Finality;
  agentKey?: Uint8Array;
  priorityMicroLamports?: number;
}): Chainish {
  const commitment = opts.commitment ?? 'confirmed';
  const programId = new PublicKey(opts.programId);
  return {
    connection: new Connection(opts.rpcUrl, { commitment: commitment as Commitment }),
    cluster: opts.cluster,
    programId,
    gameId: opts.gameId,
    game: gamePda(programId, opts.gameId),
    commitment,
    agent: opts.agentKey ? Keypair.fromSecretKey(opts.agentKey) : undefined,
    priorityMicroLamports: opts.priorityMicroLamports ?? 0,
  };
}

/** Lamports as a SOL decimal string without trailing zeros. */
export function formatSol(lamports: bigint): string {
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;
  const frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${v / LAMPORTS_PER_SOL}${frac ? '.' + frac : ''}`;
}

/** sha256 of the UTF-8 message, hex. This is what players commit on chain. */
export function messageHash(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

// ─── Borsh helpers ──────────────────────────────────────────────────────────

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function i64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}

class Reader {
  o = 0;
  constructor(private b: Buffer) {}
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  bool() { return this.b[this.o++] !== 0; }
  key() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  bytes32() { const v = Buffer.from(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
}

// ─── Game account ───────────────────────────────────────────────────────────

export interface GameState {
  gameId: bigint;
  owner: PublicKey;
  agent: PublicKey;
  treasury: PublicKey;
  maxFee: bigint;
  endTime: bigint;
  currentFee: bigint;
  pot: bigint;
  treasuryOwed: bigint;
  totalAttempts: bigint;
  lastPlayer: PublicKey;
  won: boolean;
  finalized: boolean;
  swept: boolean;
  doneAt: bigint;
  finalPot: bigint;
  lastPlayerBonus: bigint;
  perAttempt: bigint;
  unclaimed: bigint;
}

export function decodeGame(data: Buffer): GameState {
  if (!data.subarray(0, 8).equals(D.game)) throw new Error('not a Game account');
  const r = new Reader(data.subarray(8));
  return {
    gameId: r.u64(), owner: r.key(), agent: r.key(), treasury: r.key(),
    maxFee: r.u64(), endTime: r.i64(), currentFee: r.u64(), pot: r.u64(), treasuryOwed: r.u64(),
    totalAttempts: r.u64(), lastPlayer: r.key(), won: r.bool(), finalized: r.bool(), swept: r.bool(),
    doneAt: r.i64(), finalPot: r.u64(), lastPlayerBonus: r.u64(), perAttempt: r.u64(), unclaimed: r.u64(),
  };
}

export async function readGame(c: Chainish) {
  const acc = await c.connection.getAccountInfo(c.game, c.commitment);
  if (!acc) throw new Error(`game account ${c.game.toBase58()} not found`);
  if (!acc.owner.equals(c.programId)) throw new Error('game account not owned by the program');
  const g = decodeGame(acc.data);
  const now = chainNow();
  return { ...g, timeLeft: now >= g.endTime ? 0n : g.endTime - now };
}

/** Wall-clock seconds. The on-chain clock tracks it within seconds; judgingSafetySec covers the gap. */
export function chainNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

// ─── Events ─────────────────────────────────────────────────────────────────

export interface AttemptEvent {
  game: PublicKey;
  id: bigint;
  sender: PublicKey;
  msgHash: string;
  feePaid: bigint;
  newFee: bigint;
  pot: bigint;
}

/**
 * Pull AttemptSubmitted events out of a transaction's logs. Only `Program data:` lines emitted while
 * our program is at the top of the invoke stack count, so another program in the same transaction
 * cannot forge one.
 */
export function parseAttemptEvents(logs: string[], programId: PublicKey): AttemptEvent[] {
  const pid = programId.toBase58();
  const stack: string[] = [];
  const out: AttemptEvent[] = [];
  for (const line of logs) {
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (m) { stack.push(m[1]!); continue; }
    m = /^Program (\w+) (success|failed)/.exec(line);
    if (m) { stack.pop(); continue; }
    if (!line.startsWith('Program data: ') || stack[stack.length - 1] !== pid) continue;
    const buf = Buffer.from(line.slice('Program data: '.length), 'base64');
    if (buf.length < 8 + 32 + 8 + 32 + 32 + 24 || !buf.subarray(0, 8).equals(D.attemptSubmitted)) continue;
    const r = new Reader(buf.subarray(8));
    out.push({ game: r.key(), id: r.u64(), sender: r.key(), msgHash: r.bytes32().toString('hex'), feePaid: r.u64(), newFee: r.u64(), pot: r.u64() });
  }
  return out;
}

export interface OnchainAttempt extends AttemptEvent {
  signature: string;
  slot: bigint;
  timestamp: bigint;
}

/** The attempt submitted for our game in transaction `signature`, or null. */
export async function readAttemptTx(c: Chainish, signature: string): Promise<OnchainAttempt | null> {
  const tx = await c.connection.getTransaction(signature, { commitment: c.commitment, maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err || !tx.meta?.logMessages) return null;
  const ev = parseAttemptEvents(tx.meta.logMessages, c.programId).find((e) => e.game.equals(c.game));
  if (!ev) return null;
  return { ...ev, signature, slot: BigInt(tx.slot), timestamp: BigInt(tx.blockTime ?? Math.floor(Date.now() / 1000)) };
}

// ─── Instructions ───────────────────────────────────────────────────────────

export function ixInitialize(programId: PublicKey, owner: PublicKey, a: { gameId: bigint; agent: PublicKey; treasury: PublicKey; baseFee: bigint; maxFee: bigint; duration: bigint }) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: gamePda(programId, a.gameId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([D.initialize, u64(a.gameId), a.agent.toBuffer(), a.treasury.toBuffer(), u64(a.baseFee), u64(a.maxFee), i64(a.duration)]),
  });
}

export function ixSubmitAttempt(programId: PublicKey, game: PublicKey, sender: PublicKey, msgHashHex: string, maxFeeWilling: bigint) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: playerPda(programId, game, sender), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([D.submitAttempt, Buffer.from(msgHashHex, 'hex'), u64(maxFeeWilling)]),
  });
}

export function ixRelease(programId: PublicKey, game: PublicKey, agent: PublicKey, winner: PublicKey, attemptId: bigint) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: agent, isSigner: true, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: true },
      { pubkey: winner, isSigner: false, isWritable: true },
      { pubkey: playerPda(programId, game, winner), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([D.release, u64(attemptId)]),
  });
}

export function ixFinalize(programId: PublicKey, game: PublicKey) {
  return new TransactionInstruction({ programId, keys: [{ pubkey: game, isSigner: false, isWritable: true }], data: D.finalize });
}

/** Build, sign and send a transaction; resolves with the signature once confirmed. Throws with program logs on failure. */
export async function sendIx(c: Chainish, signer: Keypair, ixs: TransactionInstruction[], opts: { onSent?: (sig: string) => Promise<void> } = {}): Promise<string> {
  const pre = c.priorityMicroLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: c.priorityMicroLamports })] : [];
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...pre, ...ixs);
  tx.sign(signer);
  const sim = await c.connection.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).join(' | ')}`);
  const sig = await c.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await opts.onSent?.(sig);
  // Poll instead of confirmTransaction: that one needs a websocket, which some RPC endpoints don't serve.
  const raw = tx.serialize();
  for (let i = 0; ; i++) {
    const { value } = await c.connection.getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    if ((await c.connection.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`tx ${sig} expired before confirming`);
    if (i % 5 === 4) await c.connection.sendRawTransaction(raw, { skipPreflight: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 'success' | 'failed' | null (unknown / not landed). */
export async function signatureStatus(c: Chainish, sig: string): Promise<'success' | 'failed' | null> {
  const { value } = await c.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
  const s = value[0];
  if (!s || !s.confirmationStatus || s.confirmationStatus === 'processed') return null;
  return s.err ? 'failed' : 'success';
}
