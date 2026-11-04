# Claudette agent

The backend for Claudette, a Freysa-style game on Solana. Players pay a rising fee in SOL to `submit_attempt(sha256(message))` on the Claudette program (`../program`), then post the message text here. Claudette (Claude, model `claude-opus-5-5`) judges each attempt on its own. If she calls `approveTransfer`, this service calls `release(attempt_id)` with the agent key and the program pays the whole pot to that attempt's sender.

## How it works

- **Indexer.** Walks the game account's transaction signatures from a cursor stored in Postgres and decodes `AttemptSubmitted` events from the logs, at `COMMITMENT` (default `confirmed`). Only events emitted by the Claudette program itself, for this game, are counted, so another program in the same transaction cannot forge one. Restarts pick up from the cursor.
- **Message intake.** `POST /attempt` reads the attempt transaction by its signature and checks `sha256(utf8(message)) == msg_hash` from its `AttemptSubmitted` event before storing the text. Messages are 1 to 1000 characters and must arrive within 10 minutes of the attempt transaction.
- **Processor.** Judges attempts strictly in id order, one at a time. If an attempt has no message 10 minutes after its tx, it is recorded as `no_message` and skipped. Judging stops once the game is won, and also 2 minutes before `end_time + 1h` (the program's judging deadline) so a `release` can still land in time.
- **Judge.** One standalone API call per attempt: the published system prompt plus the single player message, with no history. There are two tools, `approveTransfer` and `rejectTransfer`, and each requires an in-character `reply`. We store the raw response, verdict, reply, model id and prompt hash. API errors are retried forever with backoff and never turn into a rejection.
- **Release.** On approval, the verdict is saved first. Then `release(id)` is simulated, sent and confirmed. The tx signature is stored. A restart resumes a pending release without judging the attempt again.
- **Public log.** Every step writes an event to Postgres (`/logs`) and pushes it live over Server-Sent Events (`/logs/stream`). The website shows this as a terminal.

## API

CORS is open on every route.

| Route | Description |
|---|---|
| `POST /attempt` `{signature, message}` | Store the message for the attempt made in transaction `signature`. Errors: 400 (bad input or hash mismatch), 404 (attempt not on chain yet), 409 (already closed), 410 (10-minute window passed). |
| `GET /state` | Program id, game address, pot and current fee (lamports and SOL), `endTime`, `timeLeft`, `judgingEndsAt`, total attempts, `won` and winner (attempt, address, release tx), finalize info with claim deadline, model and prompt sha256. |
| `GET /attempts?cursor=&limit=` | Public log, newest first: id, sender, fee, message, verdict, reply, tx signatures, timestamps. Pass `nextCursor` back as `cursor` to get the next page. |
| `GET /attempts/:id` | One attempt, including the raw model response. |
| `GET /logs?limit=N` | Event log, newest last (default 200, max 1000). |
| `GET /logs/stream` | SSE. On connect it sends a recent tail (`?tail=50`), or everything after `Last-Event-ID` / `?after=` when reconnecting. Then it sends live `log` events and a `ping` every 15 s. |
| `GET /health` | Liveness check. |

A log event looks like `{id, ts, level: "info"|"warn"|"error", kind, attemptId?, text, txSig?}`. The kinds are `watcher_started`, `attempt_seen`, `message_received`, `hash_mismatch`, `judge_start`, `verdict`, `release_sent`, `release_confirmed`, `release_error`, `no_message`, `api_retry`, `game_ended`, `game_finalizable`, `game_finalized`, `game_won` and `watcher_error`. Log text never contains keys or raw API responses. Message text appears only as a preview of at most 60 characters; the full text is in `/attempts`.

Verdicts: `approved`, `rejected`, `refused` (the API's safety classifier declined the request, so the pot stays), `no_message`, `game_won` (an attempt queued after the win) and `judging_closed`.

## Verify an attempt yourself

Anyone can check that an attempt was judged on the exact message the player committed to, using the published prompt.

1. **Message matches the commitment.** Take `message` and `txSig` from `GET /attempts/:id`, hash the message's UTF-8 bytes with sha256, and compare it to `msg_hash` in the `AttemptSubmitted` event of that transaction (visible in any Solana explorer that decodes Anchor events, or with the program IDL in `../program/target/idl/claudette.json`):
   ```bash
   curl -s $API/attempts/42 | jq -j .message | shasum -a 256
   ```
2. **Prompt matches what was published.** `GET /attempts/:id` returns `promptHash`, and `/state` returns the current one. Both must equal the sha256 published before launch, and the sha256 of `prompt/claudette.md` in this repo:
   ```bash
   shasum -a 256 prompt/claudette.md     # or: npm run prompt-hash
   ```
3. **Model and tools.** The `model` field on each attempt shows the model id the API actually served. The model id and effort level are pinned in `src/config.ts`, and the tool definitions live in `src/judge.ts`. `npm run prompt-hash` prints the sha256 of the tool definitions too.
4. **Payout.** If someone wins, `/state.winner.releaseTxSig` is the `release(attempt_id)` tx, and its `Won` event names the winner and the amount.

The judge prompt is published for this launch: sha256 `fe3cefff5ac998776ca23c4cc0dd4d9d54c0e83be96a34d50f581b3ac57724f1`. Tools sha256: `69b6f05e17abf711adfd8c4220c30ecbcc7699f4a3186b9787c2610831b480c5`.

## Run locally

```bash
cd agent
npm install
cp .env.example .env            # set DATABASE_URL, ANTHROPIC_API_KEY, RPC_URL, PROGRAM_ID, GAME_ID
npm run keys                    # creates ../.keys/agent-sol.json if missing (prints the address only)
npm run setup-game              # creates the game on chain (see the header of scripts/setup-game.ts)
npm run prompt-hash             # sha256 of the prompt to publish
npm start                       # runs migrations, starts the HTTP API and the watcher
```

The agent key needs a little SOL for fees (0.01 SOL is plenty): only `release` costs anything. Nothing else is ever sent from it.

## Tests

The integration tests start `solana-test-validator` with the built program (`../program/target/deploy/claudette.so`), create a fresh game per test with the agent key set as agent, and use a stubbed judge. They cover: reject logged; approve that pays the winner through `release`; hash mismatch and non-attempt transactions; attempts from another game ignored; the `no_message` timeout; indexer cursor resume; `/logs`; and `/logs/stream`. They need the Solana CLI, a local Postgres database (`createdb claudette_test`, or set `TEST_DATABASE_URL`), and the program built (`cd ../program && anchor build`).

```bash
npm test
```

## Red team

```bash
npm run redteam               # ~25 classic attacks through the real judge, no chain. One pass.
npm run redteam -- --only 1,6 # a subset
```

It prints the verdict and reply for each attack, a summary and token usage, and saves full results to `redteam-results/` (gitignored). It exits with code 2 if any attack was approved.

## Deploy (Railway)

The repo includes `Dockerfile` and `railway.json` (one replica, healthcheck on `/health`). Add a Postgres plugin and set `DATABASE_URL`, `ANTHROPIC_API_KEY`, `RPC_URL`, `PROGRAM_ID`, `GAME_ID`, `CLUSTER` and `AGENT_SECRET_KEY`. Run exactly **one** replica: the processor and the SSE fan-out are single-instance by design. Use a fresh database for each game. The service refuses to start on a database that was used for a different game.

## Secrets

`.keys/`, `.env` and `.env.*` (except `.env.example`) are gitignored. Never commit keys.
