# Claudette web

Next.js (App Router, TypeScript) site for Claudette, a game on Solana where you pay SOL to send one message to an AI guarding a SOL pot.

Wallets: Privy (`@privy-io/react-auth`) with external Solana wallets (Phantom, Solflare, Backpack and any detected Solana wallet). Transactions are built with `@solana/web3.js` in `lib/solana.ts` and signed and sent through Privy.

## Run

```bash
npm install
npm run dev:mock        # fake data, fake log stream, fake payments: no backend or contract needed
npm run dev             # real mode: needs NEXT_PUBLIC_API_URL and NEXT_PUBLIC_CLAUDETTE_ADDRESS
npm run build
```

To preview end states in mock mode, add `?mock=won` or `?mock=finalized` to the URL.

## Environment

See `.env.example`.

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `mainnet-beta` (default) or `devnet` |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | RPC for reads and transaction building (use a domain-restricted key) |
| `NEXT_PUBLIC_PROGRAM_ID` | Claudette program id |
| `NEXT_PUBLIC_GAME_ID` | Game number (default 1) |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app id; the site's domains must be allowed origins in the Privy dashboard |
| `NEXT_PUBLIC_API_URL` | Agent backend base URL, no trailing slash |
| `NEXT_PUBLIC_GITHUB_URL` | Repo link (footer + transparency) |
| `NEXT_PUBLIC_PROMPT_SHA256` | System prompt sha256 (falls back to `/state.promptHash`) |
| `NEXT_PUBLIC_MODEL_ID` | Fallback model id if `/state` is down |
| `NEXT_PUBLIC_SITE_URL` | Canonical URL for social cards |
| `NEXT_PUBLIC_MOCK` | `1` = mock mode |
| `NEXT_PUBLIC_COMING_SOON` | `1` = coming-soon page instead of the game (see below) |
| `NEXT_PUBLIC_LAUNCH_AT` | Optional ISO date, e.g. `2026-11-14T17:00:00Z`: live countdown on the coming-soon page. Unset shows "SOON / 近日公開" |

## Coming-soon mode

```bash
NEXT_PUBLIC_COMING_SOON=1 npm run dev
NEXT_PUBLIC_COMING_SOON=1 NEXT_PUBLIC_LAUNCH_AT=2026-11-14T17:00:00Z npm run build
```

`app/page.tsx` renders `components/ComingSoon.tsx` instead of the game, and `app/layout.tsx` skips the Privy/react-query providers, so the page makes no wallet, API, RPC or SSE calls and needs no backend. It shows the alley clip (`public/claudette/soon/alley.mp4`, poster `alley-poster.jpg`), the wordmark, a countdown or SOON sign, a decorative terminal, the X follow button and an expandable rules box. The GitHub link only appears when `NEXT_PUBLIC_GITHUB_URL` is set. With `prefers-reduced-motion` the video stays on its poster and the glitch and typing effects are off. Metadata and the OG image are the same as the game. These are `NEXT_PUBLIC_` vars, so they are baked in at build time: rebuild to switch modes.

## Attempt flow

1. `sha256(utf8(message))` is computed in the browser.
2. `submit_attempt(hash, max_fee_willing)` is built with the live fee read from the game account plus a 1.6% allowance (only the live fee is charged; if the fee rose more than that the transaction fails and nothing is charged). The wallet signs and sends it through Privy.
3. The signature is polled until confirmed.
4. `POST /attempt {signature, message}` (retried on 404/5xx while the backend catches up with the chain). The response carries the attempt id.
5. `GET /attempts/:id` is polled every 2s until `verdict` is no longer `pending` / `awaiting_message`.

A wallet's first attempt also creates its player record, a refundable rent deposit of about 0.00145 SOL. It comes back on `claim`, or through "Get your player deposit back" (`close_player`) after a win or after unclaimed shares are swept.

The pending message is kept in `localStorage` (`claudette:pending:sol:v1`) from before the wallet prompt until a verdict arrives, so a refresh after paying still delivers it (within the backend's `messageTimeoutSec`).

## Backend contract

The site uses the shapes in `../agent/src/server.ts` (`/state`, `/attempts`, `/attempts/:id`, `POST /attempt`) plus:

- `GET /logs?limit=N` returns `{ items: LogEvent[] }` or a bare `LogEvent[]` (either works, any order; the site sorts by `ts`).
- `GET /logs/stream` is Server-Sent Events. Each event's `data:` is one JSON `LogEvent`. Unnamed events or `event: log` both work. Comment lines (`: ping`) are fine as keepalives. CORS must allow the site origin.

```ts
interface LogEvent {
  id?: string | number;        // recommended: used to dedupe backfill vs stream
  ts: string | number;         // ISO string, unix seconds or unix ms
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;                // styled kinds: boot, index, attempt, verify, judge, verdict, release, won, timer
  attemptId?: number | null;
  text: string;                // any transaction signature in the text is auto-linked to Solscan
  txSig?: string | null;       // linked to Solscan
}
```

Optional extras the site already reads if present:

- `state.winner.amountLamports`: the released amount (otherwise the newest attempt's `potAfterLamports` is used).
- `attempt.expression`: one of `smug bored intrigued sly laugh shocked stunned crying` to pick her face (otherwise derived from the verdict).

## Images

`public/claudette/` holds webp crops of `../brand`: 8 expressions (560px + 96px thumbs), banner, pfp, character sheet and an OG card.
