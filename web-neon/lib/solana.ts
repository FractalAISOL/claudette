import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { GAME_ID, PROGRAM_ID, RPC_URL } from './config';

const enc = new TextEncoder();
let _conn: Connection | null = null;
export const connection = () => (_conn ??= new Connection(RPC_URL, 'confirmed'));

async function disc(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))).slice(0, 8);
}

/** sha256 of the UTF-8 message, hex. This is what the player commits on chain. */
export async function messageHash(message: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(message)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const cat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

export function programId(): PublicKey {
  if (!PROGRAM_ID) throw new Error('The program id is not configured.');
  return new PublicKey(PROGRAM_ID);
}
export const gamePda = () => PublicKey.findProgramAddressSync([enc.encode('game'), u64(GAME_ID)], programId())[0];
export const playerPda = (wallet: PublicKey) => PublicKey.findProgramAddressSync([enc.encode('player'), gamePda().toBytes(), wallet.toBytes()], programId())[0];

/** Read the live fee straight from the game account (offset of current_fee in the Game layout). */
export async function readCurrentFee(): Promise<bigint> {
  const acc = await connection().getAccountInfo(gamePda());
  if (!acc) throw new Error('Game account not found.');
  // 8 disc + game_id 8 + owner 32 + agent 32 + treasury 32 + max_fee 8 + end_time 8
  return new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(8 + 8 + 32 * 3 + 8 + 8, true);
}

/** Attempts recorded for `wallet` in this game, or null if it has no player account. */
export async function readPlayerAttempts(wallet: PublicKey): Promise<bigint | null> {
  const acc = await connection().getAccountInfo(playerPda(wallet));
  if (!acc || acc.data.length < 8 + 64 + 8) return null;
  return new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(8 + 64, true);
}

async function ix(name: string, keys: TransactionInstruction['keys'], args: Uint8Array = new Uint8Array()) {
  return new TransactionInstruction({ programId: programId(), keys, data: Buffer.from(cat(await disc(`global:${name}`), args)) });
}

export async function ixSubmitAttempt(sender: PublicKey, msgHashHex: string, maxFeeWilling: bigint) {
  return ix(
    'submit_attempt',
    [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: gamePda(), isSigner: false, isWritable: true },
      { pubkey: playerPda(sender), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    cat(hexBytes(msgHashHex), u64(maxFeeWilling)),
  );
}

const walletAndPlayer = (wallet: PublicKey) => [
  { pubkey: wallet, isSigner: true, isWritable: true },
  { pubkey: gamePda(), isSigner: false, isWritable: true },
  { pubkey: playerPda(wallet), isSigner: false, isWritable: true },
];
export const ixClaim = (wallet: PublicKey) => ix('claim', walletAndPlayer(wallet));
export const ixClosePlayer = (wallet: PublicKey) =>
  ix('close_player', walletAndPlayer(wallet).map((k, i) => (i === 1 ? { ...k, isWritable: false } : k)));
export const ixFinalize = () => ix('finalize', [{ pubkey: gamePda(), isSigner: false, isWritable: true }]);

/** Unsigned transaction bytes for the wallet to sign and send. */
export async function buildTx(feePayer: PublicKey, ixs: TransactionInstruction[]): Promise<Uint8Array> {
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/** Wait until `sig` is confirmed. Throws with the program error if it failed. */
export async function waitConfirmed(sig: string, timeoutMs = 90_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { value } = await connection().getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = value[0];
    if (s?.err) throw new Error(`The transaction failed on chain: ${programErrorName(s.err) ?? JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The transaction did not confirm in time. Check your wallet history before trying again.');
}

/** Anchor custom error codes start at 6000, in ClaudetteError order. */
const ERRORS = ['ZeroAddress', 'InvalidConfig', 'NotAgent', 'NotOwner', 'GameWon', 'GameFinalized', 'GameEnded', 'GameNotOver', 'JudgingClosed', 'FeeTooHigh', 'InvalidAttempt', 'NotFinalized', 'ClaimWindowClosed', 'ClaimWindowOpen', 'AlreadySwept', 'NothingToWithdraw', 'TreasuryNotWithdrawn', 'WrongTreasury'];
export function programErrorName(err: unknown): string | null {
  const s = typeof err === 'string' ? err : JSON.stringify(err);
  const m = /"Custom":(\d+)/.exec(s) ?? /custom program error: 0x([0-9a-f]+)/i.exec(s);
  if (!m) return null;
  const code = m[0].includes('0x') ? parseInt(m[1]!, 16) : Number(m[1]);
  return ERRORS[code - 6000] ?? null;
}
