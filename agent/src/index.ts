import { serve } from '@hono/node-server';
import { loadConfig, JUDGE_MODEL, JUDGE_EFFORT } from './config.js';
import { makeChain, readGame, chainNow, GRACE_SEC } from './chain.js';
import { makeDb, migrate, getMeta, setMeta } from './db.js';
import { ClaudeJudge, toolsSha256 } from './judge.js';
import { makeApp } from './server.js';
import { Watcher } from './watcher.js';
import { EventLog, preview } from './events.js';

async function main() {
  const cfg = loadConfig();
  const db = makeDb(cfg.databaseUrl);
  await migrate(db);

  const chain = makeChain({
    rpcUrl: cfg.rpcUrl,
    cluster: cfg.cluster,
    programId: cfg.programId,
    gameId: cfg.gameId,
    commitment: cfg.commitment,
    agentKey: cfg.agentKey,
    priorityMicroLamports: cfg.priorityMicroLamports,
  });
  const gameKey = chain.game.toBase58();
  const known = await getMeta(db, 'game');
  if (known && known !== gameKey) {
    throw new Error(`database belongs to game ${known}, config says ${gameKey}. Use a fresh DATABASE_URL per game.`);
  }
  if (!known) await setMeta(db, 'game', gameKey);

  const game = await readGame(chain);
  const agentAddr = chain.agent?.publicKey;
  console.log(`[boot] program ${chain.programId.toBase58()} game #${game.gameId} ${gameKey} on ${cfg.cluster}`);
  console.log(`[boot] on-chain agent ${game.agent.toBase58()}; our key ${agentAddr?.toBase58() ?? '(none: cannot release)'}`);
  if (!agentAddr || !agentAddr.equals(game.agent)) console.warn('[boot] WARNING: our key is not the game agent; approvals cannot be paid out');

  const events = new EventLog(db);
  const judge = new ClaudeJudge({
    log: (m) => {
      console.warn(m);
      void events.emit({ level: 'warn', kind: 'api_retry', text: preview(m.replace(/^\[judge\]\s*/, 'Claude API: '), 200) });
    },
    shouldContinue: async () => {
      const g = await readGame(chain);
      const now = chainNow();
      return !g.won && !g.finalized && now < g.endTime + GRACE_SEC - BigInt(cfg.judgingSafetySec);
    },
  });
  console.log(`[boot] judge ${JUDGE_MODEL} effort ${JUDGE_EFFORT} prompt sha256 ${judge.promptHash} tools sha256 ${toolsSha256()}`);

  const app = makeApp({ db, chain, messageTimeoutSec: cfg.messageTimeoutSec, promptHash: judge.promptHash, model: JUDGE_MODEL, events });
  serve({ fetch: app.fetch, port: cfg.port }, (i) => console.log(`[http] listening on :${i.port}`));

  const watcher = new Watcher({
    db, chain, judge,
    messageTimeoutSec: cfg.messageTimeoutSec,
    judgingSafetySec: cfg.judgingSafetySec,
    pollMs: cfg.pollMs,
    model: JUDGE_MODEL,
    promptHash: judge.promptHash,
    events,
  });
  const shutdown = () => { watcher.stop(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await watcher.run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
