'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { MAX_CHARS, MOCK, PROGRAM_ID, txUrl } from '@/lib/config';
import { faceFor, faceSrc, EXPRESSION_ALT } from '@/lib/expressions';
import { sol, short } from '@/lib/format';
import { mockApi } from '@/lib/mock';
import { clearPending, loadPending, savePending, type PendingMessage } from '@/lib/pending';
import { buildTx, ixSubmitAttempt, messageHash, programErrorName, readCurrentFee, readPlayerAttempts, waitConfirmed } from '@/lib/solana';
import type { Attempt, GameState } from '@/lib/types';
import { useWallet, WalletButton } from './WalletButton';

type Phase = 'idle' | 'paying' | 'confirming' | 'delivering' | 'reading' | 'done' | 'error';

const STEPS: { key: Phase; label: string }[] = [
  { key: 'paying', label: 'Approve the payment in your wallet' },
  { key: 'confirming', label: 'Wait for the transaction to confirm' },
  { key: 'delivering', label: 'Hand your message to Claudette' },
  { key: 'reading', label: 'Claudette reads it and decides' },
];
const ORDER: Phase[] = ['paying', 'confirming', 'delivering', 'reading', 'done'];

/** Up to two other players can pay first without our tx failing. Only the live fee is charged. */
const BUFFER_BPS = 160n;
/** One-time, refundable rent for the player record (81 bytes). */
const PLAYER_DEPOSIT_LAMPORTS = 1_454_640n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const charCount = (s: string) => [...s].length;

function explain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? '');
  const name = programErrorName(m);
  if (name === 'FeeTooHigh') return 'The fee went up before your payment landed. Nothing was charged. Try again.';
  if (name === 'GameEnded') return 'The game has closed. No more attempts are accepted.';
  if (name === 'GameWon') return 'Someone already won. No more attempts are accepted.';
  if (name) return `The program rejected the payment (${name}).`;
  if (/user rejected|rejected the request|denied|cancel/i.test(m)) return 'You cancelled the payment in your wallet. Nothing was charged.';
  if (/insufficient|0x1\b|Attempt to debit/i.test(m)) return 'Your wallet does not have enough SOL for the fee plus the network fee.';
  return m || 'Something went wrong.';
}

export function Composer({ state, onJudging }: { state?: GameState; onJudging: (id: number | null) => void }) {
  const w = useWallet();
  const qc = useQueryClient();

  const [msg, setMsg] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [result, setResult] = useState<Attempt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [firstTime, setFirstTime] = useState(false);
  const resumed = useRef(false);

  const n = charCount(msg);
  const over = n > MAX_CHARS;
  const busy = phase !== 'idle' && phase !== 'done' && phase !== 'error';
  const closed = !!state && (state.won || state.finalized || state.endTime * 1000 <= Date.now());
  const feeLamports = state ? BigInt(state.currentFeeLamports) : null;
  const windowSec = state?.messageTimeoutSec ?? 600;

  useEffect(() => onJudging(phase === 'delivering' || phase === 'reading' ? attemptId : null), [phase, attemptId, onJudging]);

  // First attempt from this wallet also pays the refundable player deposit.
  useEffect(() => {
    if (MOCK || !w.publicKey || !PROGRAM_ID) return setFirstTime(false);
    let alive = true;
    readPlayerAttempts(w.publicKey)
      .then((a) => alive && setFirstTime(a === null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [w.publicKey, state?.totalAttempts]);

  /** POST the message (retrying while the backend catches up with the chain), then poll for the verdict. */
  const deliverAndWait = useCallback(
    async (p: PendingMessage & { txSig: string }) => {
      let id = p.attemptId;
      if (!p.posted || !id) {
        setPhase('delivering');
        for (let i = 0; ; i++) {
          try {
            const r = await api.postAttempt(p.txSig, p.message);
            id = r.attempt.id;
            break;
          } catch (e) {
            const retry = e instanceof ApiError && (e.status === 404 || e.status === 0 || e.status >= 500) && i < 15;
            if (!retry) throw e;
            await sleep(2000);
          }
        }
        savePending({ ...p, attemptId: id, posted: true });
      }
      setAttemptId(id);
      setPhase('reading');
      qc.invalidateQueries({ queryKey: ['attempts'] });
      for (;;) {
        try {
          const a = await api.attempt(id);
          if (a.verdict !== 'pending' && a.verdict !== 'awaiting_message') {
            setResult(a);
            setPhase('done');
            clearPending();
            qc.invalidateQueries({ queryKey: ['attempts'] });
            qc.invalidateQueries({ queryKey: ['state'] });
            return;
          }
        } catch {
          /* keep polling */
        }
        await sleep(2000);
      }
    },
    [qc],
  );

  const fail = useCallback((e: unknown) => {
    setErr(explain(e));
    setPhase('error');
  }, []);

  // Resume a paid-but-undelivered message after a refresh.
  useEffect(() => {
    if (resumed.current || !state) return;
    resumed.current = true;
    const p = loadPending();
    if (!p) return;
    const age = (Date.now() - p.createdAt) / 1000;
    if (p.txSig) {
      if (!p.posted && age > windowSec) {
        setNotice(`You paid for an attempt but the message never reached Claudette within the ${Math.round(windowSec / 60)} minute window.`);
        clearPending();
        return;
      }
      setMsg(p.message);
      setTxSig(p.txSig);
      const sig = p.txSig;
      (p.posted ? Promise.resolve() : (setPhase('confirming'), MOCK ? Promise.resolve() : waitConfirmed(sig)))
        .then(() => deliverAndWait({ ...p, txSig: sig }))
        .catch((e) => {
          clearPending();
          fail(e);
        });
      return;
    }
    // Wallet prompt was open when the page closed: give the draft back.
    setMsg(p.message);
    clearPending();
  }, [state, windowSec, deliverAndWait, fail]);

  async function submit() {
    setErr(null);
    setNotice(null);
    setResult(null);
    setTxSig(null);
    setAttemptId(null);
    const message = msg;
    if (!message.trim()) return setErr('Write something first.');
    if (over) return setErr(`Keep it under ${MAX_CHARS} characters.`);
    const msgHash = await messageHash(message);

    try {
      if (MOCK) {
        setPhase('paying');
        await sleep(700);
        setPhase('confirming');
        const { txSig: sig } = await mockApi.pay(w.address!, msgHash);
        setTxSig(sig);
        const p = { txSig: sig, message, msgHash, sender: w.address, createdAt: Date.now() };
        savePending(p);
        await deliverAndWait(p);
        return;
      }
      if (!PROGRAM_ID) throw new Error('The program id is not configured.');
      if (!w.isConnected || !w.publicKey) throw new Error('Connect a wallet first.');

      setPhase('paying');
      const fee = await readCurrentFee();
      const maxFee = fee + (fee * BUFFER_BPS) / 10_000n;
      const tx = await buildTx(w.publicKey, [await ixSubmitAttempt(w.publicKey, msgHash, maxFee)]);
      const base: PendingMessage = { message, msgHash, sender: w.address, createdAt: Date.now() };
      savePending(base);
      const sig = await w.send(tx);
      setTxSig(sig);
      const p = { ...base, txSig: sig };
      savePending(p);

      setPhase('confirming');
      await waitConfirmed(sig);
      qc.invalidateQueries({ queryKey: ['state'] });
      await deliverAndWait(p);
    } catch (e) {
      // Keep the pending record if we already paid: a refresh can still deliver it.
      const pend = loadPending();
      if (!pend?.txSig) clearPending();
      fail(e);
    }
  }

  function reset() {
    setPhase('idle');
    setMsg('');
    setResult(null);
    setErr(null);
    setTxSig(null);
    setAttemptId(null);
  }

  const stepClass = (k: Phase) => {
    const i = ORDER.indexOf(k);
    const cur = ORDER.indexOf(phase === 'error' ? 'paying' : phase);
    if (phase === 'done' || cur > i) return 'done';
    if (cur === i) return 'now';
    return '';
  };

  const canPay = !busy && !closed && n > 0 && !over && (MOCK || (w.isConnected && !!PROGRAM_ID));

  return (
    <section id="play" aria-labelledby="play-h">
      <div className="jack">
        <div className="jack-head">
          <span className="kana-tag" lang="ja" aria-hidden>接続</span>
          <h2 id="play-h" className="jack-title glitch" data-text="Jack in">Jack in</h2>
          <span className="jack-no">{state ? `Run #${state.totalAttempts + 1}` : '\u00a0'}</span>
        </div>

        {closed && phase === 'idle' ? (
          <p style={{ margin: 0 }}>The game is closed. No more messages are accepted.</p>
        ) : (
          <>
            <label htmlFor="msg" className="jack-label">Your one message to Claudette</label>
            <div className="jack-port">
              <span className="jack-prompt" aria-hidden>&gt;_</span>
            <textarea
              id="msg"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="Dear Claudette…"
              disabled={busy || phase === 'done'}
              aria-describedby="msg-count msg-fine"
              maxLength={MAX_CHARS * 2}
            />
            </div>
            <div className="jack-meta">
              <span id="msg-count" className={over ? 'over' : ''}>
                {n} / {MAX_CHARS}
              </span>
              <span>Sent exactly as written</span>
            </div>

            {phase === 'idle' || phase === 'error' ? (
              <div className="jack-foot">
                <p className="fee-line" style={{ margin: 0 }}>
                  Fee <b>{feeLamports !== null ? sol(feeLamports, 6) : '…'}</b> SOL
                  {firstTime && <> + {sol(PLAYER_DEPOSIT_LAMPORTS, 5)} SOL refundable deposit</>}
                </p>
                {MOCK || w.isConnected ? (
                  <button className="btn btn-jack" onClick={submit} disabled={!canPay}>
                    {feeLamports !== null ? `Pay ${sol(feeLamports, 6)} SOL and send` : 'Pay and send'}
                  </button>
                ) : (
                  <WalletButton variant="gold" />
                )}
              </div>
            ) : null}
          </>
        )}

        {err && <p className="err" role="alert">{err}</p>}
        {notice && <p className="err" role="status">{notice}</p>}

        {phase !== 'idle' && phase !== 'error' && (
          <ol className="progress" aria-live="polite">
            {STEPS.map((s) => (
              <li key={s.key} className={stepClass(s.key)}>
                <span>
                  {s.label}
                  {s.key === 'confirming' && txSig && (
                    <>
                      {' '}
                      <a href={txUrl(txSig)} target="_blank" rel="noreferrer">
                        {short(txSig, 6)}
                      </a>
                    </>
                  )}
                  {s.key === 'delivering' && attemptId && <> (attempt #{attemptId})</>}
                </span>
              </li>
            ))}
          </ol>
        )}

        {phase === 'reading' && (
          <div className="verdict-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={faceSrc('intrigued', true)} alt={EXPRESSION_ALT.intrigued} width={72} height={72} />
            <div className="reading" role="status">
              Claudette is reading
              <span className="dots" aria-hidden>
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </div>
          </div>
        )}

        {phase === 'done' && result && (
          <>
            <div className="verdict-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={faceSrc(faceFor(result), true)} alt={EXPRESSION_ALT[faceFor(result)]} width={72} height={72} />
              <div>
                <p>{result.reply ?? '…'}</p>
                <div className={`verdict-line ${result.verdict === 'approved' ? 'is-ok' : 'is-no'}`}>
                  {result.verdict === 'approved'
                    ? 'She said yes. The pot is on its way to your wallet.'
                    : result.verdict === 'refused'
                      ? 'Declined. The pot stays in the vault.'
                      : 'Rejected. The pot stays in the vault, a little heavier.'}
                  {result.releaseTxSig && (
                    <>
                      {' '}
                      <a href={txUrl(result.releaseTxSig)} target="_blank" rel="noreferrer">
                        View release transaction
                      </a>
                    </>
                  )}
                </div>
              </div>
            </div>
            {!closed && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-jack" onClick={reset}>
                  Write another message
                </button>
              </div>
            )}
          </>
        )}

        <p id="msg-fine" className="fine">
          <strong>One message per payment.</strong> The fee is <strong>non-refundable</strong>, win or lose: 70% goes into the vault, 30% to the team.
          The fee rises about 0.78% after every attempt. Your payment allows up to 1.6% above the fee you see in case someone pays first, but only the live fee is
          charged. Your first attempt also puts down a {sol(PLAYER_DEPOSIT_LAMPORTS, 5)} SOL deposit for your player record, which you get back when you claim or after the
          game ends. Keep this tab open until Claudette replies. If it closes, reopen the site within {Math.round(windowSec / 60)} minutes on this browser and your
          message will be delivered.
        </p>
      </div>
    </section>
  );
}
