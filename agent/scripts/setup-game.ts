// Creates a game on chain. The owner keypair pays rent and can later only rotate the agent and close the finished game.
// RPC_URL=.. PROGRAM_ID=.. GAME_ID=1 BASE_FEE_SOL=0.01 MAX_FEE_SOL=1 DURATION_SECONDS=2592000 \
//   [OWNER_KEY_FILE=~/.config/solana/id.json] [AGENT_KEY_FILE=../.keys/agent-sol.json] [TREASURY=<base58>] npm run setup-game
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import { formatSol, ixInitialize, makeChain, readGame, sendIx, LAMPORTS_PER_SOL } from '../src/chain.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = (n: string, d?: string) => {
  const v = process.env[n] ?? d;
  if (v === undefined || v === '') throw new Error(`missing env ${n}`);
  return v;
};
const keypair = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f.replace(/^~/, homedir()), 'utf8')) as number[]));
const sol = (s: string) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * LAMPORTS_PER_SOL + BigInt((f + '000000000').slice(0, 9));
};
const treasuryFromFile = () => {
  const m = /TREASURY_SOL=(\w+)/.exec(readFileSync(resolve(here, '../../.keys/treasury.env'), 'utf8'));
  if (!m) throw new Error('no TREASURY_SOL in .keys/treasury.env');
  return m[1]!;
};

const owner = keypair(env('OWNER_KEY_FILE', '~/.config/solana/id.json'));
const agent = keypair(env('AGENT_KEY_FILE', resolve(here, '../../.keys/agent-sol.json')));
const treasury = new PublicKey(process.env.TREASURY ?? treasuryFromFile());
const gameId = BigInt(env('GAME_ID', '1'));
const chain = makeChain({ rpcUrl: env('RPC_URL'), cluster: env('CLUSTER', 'devnet'), programId: env('PROGRAM_ID'), gameId });
const args = {
  gameId,
  agent: agent.publicKey,
  treasury,
  baseFee: sol(env('BASE_FEE_SOL')),
  maxFee: sol(env('MAX_FEE_SOL')),
  duration: BigInt(env('DURATION_SECONDS')),
};
console.log(`owner ${owner.publicKey.toBase58()}  agent ${agent.publicKey.toBase58()}  treasury ${treasury.toBase58()}`);
console.log(`game #${gameId} ${chain.game.toBase58()}  base ${formatSol(args.baseFee)} SOL  max ${formatSol(args.maxFee)} SOL  duration ${args.duration}s`);
const sig = await sendIx(chain, owner, [ixInitialize(chain.programId, owner.publicKey, args)]);
const g = await readGame(chain);
console.log(`created: ${sig}\nends at ${new Date(Number(g.endTime) * 1000).toISOString()}`);
