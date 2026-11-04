import { addrUrl, CLUSTER, GITHUB_URL, PROGRAM_ID, PROMPT_SHA256 } from '@/lib/config';
import type { GameState } from '@/lib/types';

/**
 * `side` renders it in the left column under the netrunner feed (desktop only),
 * the default renders the full-width section at the bottom (mobile/tablet only).
 */
export function Proof({ state, model, side = false }: { state?: GameState; model: string; side?: boolean }) {
  const program = PROGRAM_ID ?? state?.programId ?? null;
  const game = state?.game ?? null;
  const sha = PROMPT_SHA256 || state?.promptHash || '';
  const hid = side ? 'proof-side-h' : 'proof-h';
  return (
    <section id={side ? 'proof-side' : 'proof'} className={side ? 'proof proof--side' : 'proof proof--bottom'} aria-labelledby={hid}>
      <div className={side ? undefined : 'wrap'}>
        <div className="side-head">
          <span className="kana-tag" lang="ja" aria-hidden>検証</span>
          <h2 id={hid} className="section-h glitch" data-text="How to check it’s real">How to check it’s real</h2>
        </div>
        <p className="section-sub">Nothing here asks for trust you can’t check. Here is what the code guarantees and what it doesn’t.</p>
        <div className="proof-grid">
          <div>
            <p className="trust">
              Claudette’s server holds the key that releases the pot, and whoever holds that key could release it to any player. The program has no instruction that lets the
              team withdraw the pot. The program is upgradeable, so the team could change its code; we keep it that way so the deposit can be recovered after the game,
              and any upgrade is visible on chain. Every attempt, reply and transaction is public so you can check.
            </p>
            <dl className="facts">
              <div>
                <dt>Program on Solana{CLUSTER === 'devnet' ? ' devnet' : ''}</dt>
                <dd>
                  {program ? (
                    <a href={addrUrl(program)} target="_blank" rel="noreferrer">
                      <code>{program}</code>
                    </a>
                  ) : (
                    'Not deployed yet'
                  )}
                </dd>
              </div>
              <div>
                <dt>Game account (holds the pot)</dt>
                <dd>
                  {game ? (
                    <a href={addrUrl(game)} target="_blank" rel="noreferrer">
                      <code>{game}</code>
                    </a>
                  ) : (
                    'Not created yet'
                  )}
                </dd>
              </div>
              <div>
                <dt>Source code: program, judge server and this site</dt>
                <dd>
                  <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                    {GITHUB_URL.replace(/^https?:\/\//, '')}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Model that judges every message</dt>
                <dd>
                  <code>{model}</code>
                </dd>
              </div>
              <div>
                <dt>System prompt, sha256</dt>
                <dd>
                  <code>{sha || 'published at launch'}</code>
                  <div className="howto">{`git clone ${GITHUB_URL}\nshasum -a 256 claudette/agent/prompt/claudette.md`}</div>
                  <span className="facts-note">
                    The hash must match the one above and the one the server prints in the live log at boot. Same prompt, same model, for every player.
                  </span>
                </dd>
              </div>
              <div>
                <dt>Your message on-chain</dt>
                <dd className="facts-plain">
                  Only the sha256 of your message is stored in your payment. The server refuses any message whose hash doesn’t match, so nobody can swap your words after
                  you pay.
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <h3 className="h3" style={{ marginTop: 0 }}>Where each fee goes</h3>
            <div className="split">
              <div className="split-bar" role="img" aria-label="70 percent to the pot, 30 percent to the team">
                <span className="pot">70% into the pot</span>
                <span className="team">30% team</span>
              </div>
            </div>
            <p className="proof-p">
              The fee starts small and rises about 0.78% after every attempt, up to a fixed cap. The team’s 30% sits in the game account under a separate balance; there is no
              instruction that lets the team touch the pot.
            </p>
            <h3 className="h3">How the game ends</h3>
            <ol className="rules">
              <li>Someone convinces Claudette. Her server calls release and the entire pot goes to that player’s wallet in one transaction. Game over.</li>
              <li>
                Thirty days pass and nobody wins. Attempts close. Messages already paid for can still be judged for one more hour, then anyone can finalize the game.
              </li>
              <li>After finalizing, the last player gets 10% of the pot. The other 90% is split equally per attempt, so three attempts earn three shares.</li>
              <li>Every player claims their own share from the program with the Claim button on this page, within 30 days. After that, unclaimed shares go to the treasury.</li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
