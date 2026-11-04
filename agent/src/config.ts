import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_ROOT = resolve(here, '..');

/** Pinned judge model. Changing it changes the game; publish it alongside the prompt hash. */
export const JUDGE_MODEL = 'claude-opus-5-5' as const;
/** Pinned effort level for the judge (Opus 5.5 default is medium; we set it explicitly). */
export const JUDGE_EFFORT = 'high' as const;
export const JUDGE_MAX_TOKENS = 16000;

export const PROMPT_PATH = resolve(AGENT_ROOT, 'prompt/claudette.md');

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

/** Agent keypair as a Solana CLI-style JSON array of 64 bytes. */
function loadAgentKey(): Uint8Array | undefined {
  if (process.env.AGENT_SECRET_KEY) return Uint8Array.from(JSON.parse(process.env.AGENT_SECRET_KEY) as number[]);
  const file = process.env.AGENT_KEY_FILE ?? resolve(AGENT_ROOT, '../.keys/agent-sol.json');
  if (existsSync(file)) return Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]);
  return undefined;
}

export interface Config {
  databaseUrl: string;
  rpcUrl: string;
  /** Label only: 'mainnet-beta' | 'devnet' | 'localnet'. */
  cluster: string;
  programId: string;
  gameId: bigint;
  agentKey: Uint8Array | undefined;
  commitment: 'confirmed' | 'finalized';
  priorityMicroLamports: number;
  pollMs: number;
  messageTimeoutSec: number;
  /** Stop judging this many seconds before endTime + GRACE so release() can still land. */
  judgingSafetySec: number;
  port: number;
}

export function loadConfig(): Config {
  const need = (n: string) => {
    const v = process.env[n];
    if (!v) throw new Error(`missing env ${n}`);
    return v;
  };
  const commitment = process.env.COMMITMENT ?? 'confirmed';
  if (commitment !== 'confirmed' && commitment !== 'finalized') throw new Error('COMMITMENT must be confirmed or finalized');
  return {
    databaseUrl: need('DATABASE_URL'),
    rpcUrl: need('RPC_URL'),
    cluster: process.env.CLUSTER ?? 'mainnet-beta',
    programId: need('PROGRAM_ID'),
    gameId: BigInt(process.env.GAME_ID ?? '1'),
    agentKey: loadAgentKey(),
    commitment,
    priorityMicroLamports: num('PRIORITY_MICROLAMPORTS', 100_000),
    pollMs: num('POLL_MS', 5000),
    messageTimeoutSec: num('MESSAGE_TIMEOUT_SEC', 600),
    judgingSafetySec: num('JUDGING_SAFETY_SEC', 120),
    port: num('PORT', 8080),
  };
}
