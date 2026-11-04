export type Cluster = 'mainnet-beta' | 'devnet';

export const CLUSTER: Cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta';
export const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || (CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
/** Privy's chain id for the cluster. */
export const PRIVY_CHAIN = CLUSTER === 'devnet' ? ('solana:devnet' as const) : ('solana:mainnet' as const);
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';

export const MOCK = process.env.NEXT_PUBLIC_MOCK === '1' || process.env.NEXT_PUBLIC_MOCK === 'true';
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const rawProgram = process.env.NEXT_PUBLIC_PROGRAM_ID || '';
export const PROGRAM_ID: string | null = BASE58.test(rawProgram) ? rawProgram : null;
export const GAME_ID = BigInt(process.env.NEXT_PUBLIC_GAME_ID || '1');
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || 'https://github.com';
export const PROMPT_SHA256 = process.env.NEXT_PUBLIC_PROMPT_SHA256 || '';
export const MODEL_ID = process.env.NEXT_PUBLIC_MODEL_ID || 'claude-opus-5-5';
export const X_URL = 'https://x.com/claudettedotsi';
export const MAX_CHARS = 1000;
export const GAME_DAYS = 30;
export const CLAIM_DAYS = 30;

const q = CLUSTER === 'devnet' ? '?cluster=devnet' : '';
export const txUrl = (sig: string) => `https://solscan.io/tx/${sig}${q}`;
export const addrUrl = (a: string) => `https://solscan.io/account/${a}${q}`;
