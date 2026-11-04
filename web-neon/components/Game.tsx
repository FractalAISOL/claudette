'use client';

import { useCallback, useEffect, useState } from 'react';
import { MODEL_ID } from '@/lib/config';
import { EXPRESSIONS, faceSrc } from '@/lib/expressions';
import { useGameState, useLatestAttempts, useLogStream } from '@/lib/hooks';
import { Composer } from './Composer';
import { FinalizePrompt, Finalized, WonBanner, wonAmount } from './EndStates';
import { Feed } from './Feed';
import { Footer } from './Footer';
import { Header } from './Header';
import { Hero } from './Hero';
import { Proof } from './Proof';
import { Terminal, TerminalDock } from './Terminal';
import { useWallet } from './WalletButton';

export function Game() {
  const state = useGameState();
  const head = useLatestAttempts();
  const logs = useLogStream();
  const w = useWallet();
  const [judgingId, setJudgingId] = useState<number | null>(null);
  const onJudging = useCallback((id: number | null) => setJudgingId(id), []);
  const s = state.data;
  const model = s?.model || MODEL_ID;
  const latest = head.data?.items[0];

  // Warm the cache so her face changes instantly.
  useEffect(() => {
    EXPRESSIONS.forEach((e) => {
      const i = new Image();
      i.src = faceSrc(e);
    });
  }, []);

  return (
    <>
      <Header />
      <main>
        <Hero state={s} latest={latest} judging={judgingId !== null} wonAmountLamports={wonAmount(s, latest)} />
        {state.isError && (
          <div className="wrap" style={{ paddingTop: 16 }}>
            <p className="err" role="alert">Live game data is unavailable right now. Retrying every few seconds.</p>
          </div>
        )}
        <div className="wrap main">
          <div className="col-play">
            {s?.won && <WonBanner state={s} head={latest} />}
            {s?.finalized && <Finalized state={s} />}
            {s && s.finalizable && <FinalizePrompt />}
            {!s?.won && !s?.finalized && <Composer state={s} onJudging={onJudging} />}
          </div>
          <aside className="side" aria-labelledby="term-h">
            <div className="side-head">
              <span className="kana-tag" lang="ja" aria-hidden>傍受</span>
              <h2 id="term-h" className="section-h glitch" data-text="Netrunner feed">Netrunner feed</h2>
            </div>
            <p className="section-sub">
              Tapped straight off her server: every payment seen on-chain, every hash check, every call to the model and every verdict, as it happens.
            </p>
            <Terminal lines={logs.lines} status={logs.status} model={model} />
            <Proof state={s} model={model} side />
          </aside>
          <div className="col-feed">
            <Feed me={w.address} />
          </div>
        </div>
        <Proof state={s} model={model} />
      </main>
      <Footer />
      <TerminalDock lines={logs.lines} status={logs.status} model={model} />
    </>
  );
}
