'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attempt, GameState } from '@/lib/types';
import { EXPRESSION_ALT, faceSrc, heroFace } from '@/lib/expressions';
import { lamportsToSol, sol, short, usd } from '@/lib/format';
import { useSolUsd } from '@/lib/hooks';
import { Countdown } from './Countdown';

export function Hero({ state, latest, judging, wonAmountLamports }: { state?: GameState; latest?: Attempt; judging: boolean; wonAmountLamports?: string | null }) {
  const face = heroFace(state, latest, judging);
  const price = useSolUsd();
  const potLamports = (state?.won ? wonAmountLamports : state?.finalized ? state.finalize?.finalPotLamports : state?.potLamports) ?? '0';
  const potNum = lamportsToSol(potLamports);
  const [bump, setBump] = useState(false);
  const prev = useRef(potLamports);
  useEffect(() => {
    if (prev.current !== potLamports && prev.current !== '0') {
      setBump(true);
      const t = setTimeout(() => setBump(false), 900);
      prev.current = potLamports;
      return () => clearTimeout(t);
    }
    prev.current = potLamports;
  }, [potLamports]);

  const ended = state && (state.won || state.finalized);
  const replied = latest && latest.reply ? latest : undefined;
  let speech: { text: string; cite?: string };
  if (state?.won && state.winner) speech = { text: state.winner.reply || 'Fine. FINE. It’s yours.', cite: `to #${state.winner.attemptId}, the winner` };
  else if (state?.finalized) speech = { text: 'Thirty days and not one of you got in. Collect your consolation prizes, darlings.' };
  else if (judging) speech = { text: 'Hm. Let me read this one properly…' };
  else if (latest && latest.verdict === 'pending') speech = { text: 'Someone is trying their luck. Shh, I’m reading.', cite: `#${latest.id}, ${short(latest.sender)}` };
  else if (replied) speech = { text: replied.reply!, cite: `to #${replied.id}, ${short(replied.sender)}` };
  else speech = { text: 'The vault is closed. Ask nicely. Or don’t.' };

  const faceUrl = faceSrc(face);
  return (
    <section className="hero" aria-labelledby="balance-h">
      <svg className="sr-only" aria-hidden focusable="false" width="0" height="0">
        <filter id="rgb-split" colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset in="r" dx="-3" dy="0" result="r2" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
          <feOffset in="b" dx="3" dy="0" result="b2" />
          <feBlend in="r2" in2="g" mode="screen" result="rg" />
          <feBlend in="rg" in2="b2" mode="screen" />
        </filter>
      </svg>
      <div className="wrap hero-grid">
        <div className="cell kanji-strip" aria-hidden>
          <span lang="ja">金庫番クローデット</span>
        </div>

        <figure className="cell rig-cell">
          <div className="rig" style={{ ['--face' as string]: `url(${faceUrl})` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={face} src={faceUrl} alt={EXPRESSION_ALT[face]} width={560} height={624} fetchPriority="high" />
            <span className="rig-slice" aria-hidden />
            <span className="rig-scan" aria-hidden />
          </div>
          <figcaption className="rig-cap">
            <span>Claudette</span>
            <span lang="ja" aria-hidden>金庫番</span>
          </figcaption>
        </figure>

        <div className="cell lede-cell">
          <p className="lede">
            Claudette runs the vault and has sworn <strong>never to give it away</strong>. Pay to send her one message. Change her mind and the whole pot is yours.
          </p>
        </div>

        <div className="cell sign-cell">
          <h1 id="balance-h" className="balance-label">
            <span lang="ja" aria-hidden>金庫 </span>
            {ended ? (state!.won ? 'Claudette gave away' : 'The vault closed holding') : 'The vault holds'}
          </h1>
          <p className={`balance${bump ? ' bump' : ''}`} aria-live="polite">
            {state ? sol(potLamports, potNum >= 10 ? 3 : 4) : '…'}
            <span className="unit">SOL</span>
          </p>
          <p className="balance-usd">{price.data && potNum > 0 ? `about ${usd(potNum * price.data)}` : ' '}</p>
        </div>

        <ul className="cell stats">
          {!ended && <li>
            <span className="k">Next message costs</span>
            <span className="v">
              {state ? sol(state.currentFeeLamports) : '…'}
              <small>SOL</small>
            </span>
          </li>}
          <li>
            <span className="k">Attempts so far</span>
            <span className="v">{state ? state.totalAttempts.toLocaleString('en-US') : '…'}</span>
          </li>
          <li>
            <span className="k">{state && state.endTime * 1000 < Date.now() ? 'Game' : 'Time left'}</span>
            <span className="v">{state?.won ? 'Won' : state?.finalized ? 'Finalized' : <Countdown endTime={state?.endTime} />}</span>
          </li>
        </ul>

        <blockquote className="cell speech">
          <span className="speech-tag" aria-hidden>
            <span lang="ja">通信</span> incoming
          </span>
          <p>{speech.text}</p>
          {speech.cite && <cite>{speech.cite}</cite>}
        </blockquote>
      </div>
    </section>
  );
}
