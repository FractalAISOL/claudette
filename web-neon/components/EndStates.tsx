'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { addrUrl, CLAIM_DAYS, MOCK, PROGRAM_ID, txUrl } from '@/lib/config';
import { sol, short } from '@/lib/format';
import { mockApi } from '@/lib/mock';
import { buildTx, ixClaim, ixClosePlayer, ixFinalize, readPlayerAttempts, waitConfirmed } from '@/lib/solana';
import type { Attempt, GameState } from '@/lib/types';
import { useWallet, WalletButton } from './WalletButton';

export function wonAmount(state: GameState | undefined, head?: Attempt): string | null {
  const w = state?.winner as ({ amountLamports?: string } & NonNullable<GameState['winner']>) | null | undefined;
  if (!w) return null;
  return w.amountLamports ?? (MOCK ? mockApi.wonAmountLamports() : head?.potAfterLamports ?? null);
}

/** Send one of our instructions from the connected wallet and wait for it. */
function useSendIx() {
  const w = useWallet();
  const [pending, setPending] = useState(false);
  async function run(make: (wallet: NonNullable<typeof w.publicKey>) => Promise<import('@solana/web3.js').TransactionInstruction>) {
    if (!PROGRAM_ID) throw new Error('Program not configured.');
    if (!w.publicKey) throw new Error('Connect a wallet first.');
    setPending(true);
    try {
      const sig = await w.send(await buildTx(w.publicKey, [await make(w.publicKey)]));
      await waitConfirmed(sig);
      return sig;
    } finally {
      setPending(false);
    }
  }
  return { run, pending, w };
}

/** The player's record in this game: attempts, or null once closed / never played. */
function usePlayer(address?: string) {
  const w = useWallet();
  return useQuery({
    queryKey: ['player', address],
    queryFn: () => readPlayerAttempts(w.publicKey!),
    enabled: !MOCK && !!PROGRAM_ID && !!w.publicKey,
  });
}

export function WonBanner({ state, head }: { state: GameState; head?: Attempt }) {
  const w = state.winner;
  const win = useQuery({ queryKey: ['attempt', w?.attemptId], queryFn: () => api.attempt(w!.attemptId), enabled: !!w });
  // The pot is zero after a win; the last attempt's pot snapshot is what was released.
  const amount = wonAmount(state, head);
  if (!w) return null;
  return (
    <section className="won" aria-labelledby="won-h">
      <h2 id="won-h" className="glitch" data-text="The vault is open.">The vault is open.</h2>
      {amount && <p className="amt" style={{ margin: 0 }}>{sol(amount)} SOL released</p>}
      {win.data?.message && <blockquote>{win.data.message}</blockquote>}
      {w.reply && <p className="her">Claudette: “{w.reply}”</p>}
      <dl>
        <dt>Winner</dt>
        <dd>
          <a href={addrUrl(w.address)} target="_blank" rel="noreferrer">{w.address}</a>
        </dd>
        <dt>Attempt</dt>
        <dd>#{w.attemptId}</dd>
        {w.releaseTxSig && (
          <>
            <dt>Release tx</dt>
            <dd>
              <a href={txUrl(w.releaseTxSig)} target="_blank" rel="noreferrer">{short(w.releaseTxSig, 10)}</a>
            </dd>
          </>
        )}
      </dl>
      <DepositBack />
    </section>
  );
}

/** After a win (or after unclaimed shares are swept) players can take back their player-record deposit. */
export function DepositBack() {
  const { run, pending, w } = useSendIx();
  const player = usePlayer(w.address);
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  if (MOCK || !w.isConnected || player.data === null || player.data === undefined) return null;
  async function go() {
    setMsg(null);
    try {
      await run(ixClosePlayer);
      setMsg('Done. Your deposit is back in your wallet.');
      qc.invalidateQueries({ queryKey: ['player'] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That did not go through.');
    }
  }
  return (
    <p style={{ marginTop: 14 }}>
      <button className="btn btn-sm" onClick={go} disabled={pending}>
        {pending ? 'Sending…' : 'Get your player deposit back'}
      </button>
      {msg && <span style={{ marginLeft: 10 }}>{msg}</span>}
    </p>
  );
}

export function Finalized({ state }: { state: GameState }) {
  const { run, pending, w } = useSendIx();
  const qc = useQueryClient();
  const player = usePlayer(w.address);
  const [msg, setMsg] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [mockClaimed, setMockClaimed] = useState(false);
  const f = state.finalize;
  const per = BigInt(f?.perAttemptLamports ?? '0');
  const bonus = w.address && w.address === state.lastPlayer ? BigInt(f?.lastPlayerBonusLamports ?? '0') : 0n;
  const owed: bigint | undefined = MOCK
    ? mockClaimed ? 0n : per * 3n
    : player.data === undefined ? undefined : player.data === null ? 0n : player.data * per + bonus;
  const windowOpen = !!f && !f.swept && Date.now() / 1000 < f.claimDeadline;

  async function claim() {
    setMsg(null);
    try {
      if (MOCK) {
        setMockClaimed(true);
        setMsg('Claimed (mock).');
        return;
      }
      const sig = await run(ixClaim);
      setTx(sig);
      setMsg('Claimed. The SOL is in your wallet.');
      qc.invalidateQueries({ queryKey: ['player'] });
      qc.invalidateQueries({ queryKey: ['state'] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed.');
    }
  }

  return (
    <section className="final" aria-labelledby="final-h">
      <h2 id="final-h">Nobody got in. Time to split the vault.</h2>
      <p>The game ran its thirty days. The last player gets 10% of the pot and the rest is shared per attempt. Claim yours below{f ? ` before ${new Date(f.claimDeadline * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}; after {CLAIM_DAYS} days unclaimed shares go to the treasury.</p>
      {f && (
        <ul className="ledger">
          <li><span className="k">Final pot</span><span className="lead" aria-hidden /><span className="v">{sol(f.finalPotLamports)} SOL</span></li>
          <li>
            <span className="k">Last player bonus</span><span className="lead" aria-hidden />
            <span className="v">{sol(f.lastPlayerBonusLamports)} SOL</span>
          </li>
          <li><span className="k">Per attempt</span><span className="lead" aria-hidden /><span className="v">{sol(f.perAttemptLamports, 8)} SOL</span></li>
          <li><span className="k">Last player</span><span className="lead" aria-hidden /><span className="v" style={{ fontSize: 16 }}>{short(state.lastPlayer)}</span></li>
        </ul>
      )}
      <div className="claim-row">
        {!w.isConnected ? (
          <WalletButton variant="gold" />
        ) : (
          <>
            <span className="claim-amt">{owed === undefined ? '…' : `${sol(owed, 8)} SOL`}</span>
            {windowOpen ? (
              <button className="btn btn-jack" onClick={claim} disabled={pending || (!MOCK && !player.data)}>
                {pending ? 'Claiming…' : !MOCK && !player.data ? 'Nothing to claim' : 'Claim'}
              </button>
            ) : (
              <span>The claim window has closed.</span>
            )}
          </>
        )}
      </div>
      {msg && <p className={msg.startsWith('Claimed') ? 'ok' : 'err'} style={{ marginTop: 10 }}>{msg}</p>}
      {tx && <p style={{ marginTop: 6 }}><a href={txUrl(tx)} target="_blank" rel="noreferrer" className="rel-link">View claim transaction</a></p>}
      {f?.swept && <DepositBack />}
    </section>
  );
}

/** After the deadline plus grace, anyone can close the game. */
export function FinalizePrompt() {
  const { run, pending, w } = useSendIx();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setErr(null);
    try {
      await run(() => ixFinalize());
      qc.invalidateQueries({ queryKey: ['state'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Finalize failed.');
    }
  }
  return (
    <section className="final">
      <h2>Time is up</h2>
      <p>Nobody convinced Claudette. Anyone can now close the game so players can claim their shares.</p>
      {w.isConnected ? (
        <button className="btn btn-jack" onClick={go} disabled={pending}>{pending ? 'Finalizing…' : 'Finalize the game'}</button>
      ) : (
        <WalletButton variant="gold" />
      )}
      {err && <p className="err">{err}</p>}
    </section>
  );
}
