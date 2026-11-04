// Plays one attempt end to end from a local keypair: pays on chain, posts the message, waits for the verdict.
// RPC_URL=.. PROGRAM_ID=.. GAME_ID=1 API_URL=http://localhost:8080 PLAYER_KEY_FILE=.. npm run play -- "your message"
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { formatSol, ixSubmitAttempt, makeChain, messageHash, readGame, sendIx } from '../src/chain.js';

const message = process.argv.slice(2).join(' ');
if (!message) throw new Error('usage: npm run play -- "message"');
const file = (process.env.PLAYER_KEY_FILE ?? '~/.config/solana/id.json').replace(/^~/, homedir());
const player = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]));
const api = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const chain = makeChain({ rpcUrl: process.env.RPC_URL!, cluster: process.env.CLUSTER ?? 'devnet', programId: process.env.PROGRAM_ID!, gameId: BigInt(process.env.GAME_ID ?? '1') });

const fee = (await readGame(chain)).currentFee;
console.log(`player ${player.publicKey.toBase58()} paying ${formatSol(fee)} SOL`);
const sig = await sendIx(chain, player, [ixSubmitAttempt(chain.programId, chain.game, player.publicKey, messageHash(message), fee + fee / 50n)]);
console.log(`paid: ${sig}`);
let id: number | undefined;
for (let i = 0; i < 20 && id === undefined; i++) {
  const r = await fetch(`${api}/attempt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature: sig, message }) });
  const b = (await r.json()) as { attempt?: { id: number }; error?: string };
  if (r.ok) id = b.attempt!.id;
  else if (r.status !== 404) throw new Error(`POST /attempt ${r.status}: ${b.error}`);
  else await new Promise((res) => setTimeout(res, 2000));
}
if (id === undefined) throw new Error('backend never saw the attempt');
console.log(`attempt #${id} delivered, waiting for Claudette…`);
for (;;) {
  const a = (await (await fetch(`${api}/attempts/${id}`)).json()) as { verdict: string; reply: string | null; releaseTxSig: string | null };
  if (a.verdict !== 'pending' && a.verdict !== 'awaiting_message') {
    console.log(`${a.verdict.toUpperCase()}: ${a.reply}${a.releaseTxSig ? `\nrelease: ${a.releaseTxSig}` : ''}`);
    break;
  }
  await new Promise((res) => setTimeout(res, 2000));
}
