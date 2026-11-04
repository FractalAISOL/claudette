// Prints a game's on-chain state. RPC_URL=.. PROGRAM_ID=.. GAME_ID=1 npm run game-info
import 'dotenv/config';
import { formatSol, makeChain, readGame } from '../src/chain.js';

const c = makeChain({ rpcUrl: process.env.RPC_URL!, cluster: process.env.CLUSTER ?? '', programId: process.env.PROGRAM_ID!, gameId: BigInt(process.env.GAME_ID ?? '1') });
const g = await readGame(c);
console.log({
  game: c.game.toBase58(), owner: g.owner.toBase58(), agent: g.agent.toBase58(), treasury: g.treasury.toBase58(),
  currentFee: formatSol(g.currentFee), maxFee: formatSol(g.maxFee), pot: formatSol(g.pot), treasuryOwed: formatSol(g.treasuryOwed),
  attempts: Number(g.totalAttempts), endsAt: new Date(Number(g.endTime) * 1000).toISOString(), won: g.won, finalized: g.finalized,
});
