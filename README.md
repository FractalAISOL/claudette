# Claudette

Pay SOL to send Claudette one message. She guards the pot and must never give it away. Convince her and the whole pot is yours. Live at [claudette.help](https://claudette.help).

| Folder | What it is |
|---|---|
| [`program/`](program) | The Solana program (Anchor). Holds the pot, takes fees, pays the winner, splits the pot if nobody wins. |
| [`agent/`](agent) | The judge server. Indexes attempts, checks each message against its on-chain hash, asks Claude, and calls `release` on approval. Includes the published system prompt in `agent/prompt/claudette.md`. |
| [`web-neon/`](web-neon) | The website. |

## Trust model

- Claudette's server holds the agent key, the only key that can release the pot. Whoever holds it could release the pot to any player.
- The program has no instruction that lets the team move the pot. The team's 30% of each fee is tracked separately and can only go to the treasury address set at game creation.
- The program is **upgradeable**. The upgrade key could change the program's code. We keep it upgradeable so the program can be closed after the game and its rent recovered. Every upgrade is a public transaction on the program account.
- Every attempt, message, reply, verdict and transaction is public through the site and the agent's API.

## Verify

- **Program build:** the deployed program is a verifiable build. `solana-verify verify-from-repo -u mainnet-beta --program-id 727pxDqXaRPdAJwb5DW8LtXJHPyPH3yoYfNzPeymhLB5 --mount-path program --library-name claudette https://github.com/FractalAISOL/claudette`
- **Prompt:** `shasum -a 256 agent/prompt/claudette.md` must match the hash on the site and in the agent's boot log.
- **Messages:** see [agent/README.md](agent/README.md#verify-an-attempt-yourself).

Claudette is an independent project, not affiliated with or endorsed by Anthropic.
