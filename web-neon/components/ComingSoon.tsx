'use client';

import { useEffect, useRef, useState } from 'react';

// Coming-soon mode. Zero backend: no wallet, no API, no SSE. Everything here is static or a local timer.

const X_URL = 'https://x.com/claudettedotsi';
const GITHUB = process.env.NEXT_PUBLIC_GITHUB_URL || '';
const LAUNCH_RAW = process.env.NEXT_PUBLIC_LAUNCH_AT || '';
const LAUNCH_MS = LAUNCH_RAW ? Date.parse(LAUNCH_RAW) : NaN;
const HAS_LAUNCH = Number.isFinite(LAUNCH_MS);

const pad2 = (n: number) => String(n).padStart(2, '0');

function useReducedMotion() {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}

function Backdrop() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || reduce === null) return;
    if (reduce) {
      v.pause();
    } else {
      v.play().catch(() => {});
    }
  }, [reduce]);
  return (
    <div className="cs-stage" aria-hidden>
      <div className="cs-back" />
      <video
        ref={ref}
        className="cs-video"
        src="/claudette/soon/alley.mp4"
        poster="/claudette/soon/alley-poster.jpg"
        muted
        loop
        playsInline
        autoPlay={reduce === false}
        preload={reduce ? 'none' : 'auto'}
        tabIndex={-1}
      />
      <div className="cs-shade" />
    </div>
  );
}

function Readout() {
  const now = useNow(HAS_LAUNCH);
  if (!HAS_LAUNCH) {
    return (
      <>
        <h2 className="balance-label cs-sign-label">
          <span lang="ja" aria-hidden>金庫 </span>The vault opens
        </h2>
        <p className="balance cs-soon">
          Soon<span className="unit" lang="ja">近日公開</span>
        </p>
        <p className="balance-usd cs-sign-foot">Date to be announced on X.</p>
      </>
    );
  }
  const left = now === null ? null : Math.max(0, Math.floor((LAUNCH_MS - now) / 1000));
  const parts = left === null
    ? ['--', '--', '--', '--']
    : [String(Math.floor(left / 86400)).padStart(2, '0'), pad2(Math.floor((left % 86400) / 3600)), pad2(Math.floor((left % 3600) / 60)), pad2(left % 60)];
  const labels = ['days', 'hrs', 'min', 'sec'];
  const open = left === 0;
  const when = new Date(LAUNCH_MS).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  return (
    <>
      <h2 className="balance-label cs-sign-label">
        <span lang="ja" aria-hidden>金庫 </span>{open ? 'The vault is opening' : 'The vault opens in'}
      </h2>
      <p className="balance cs-count" role="timer" aria-label={left === null ? 'Countdown loading' : `${parts[0]} days ${parts[1]} hours ${parts[2]} minutes ${parts[3]} seconds`}>
        {parts.map((p, i) => (
          <span className="cs-seg-wrap" key={labels[i]}>
            {i > 0 && <span className="cs-colon" aria-hidden>:</span>}
            <span className="cs-seg">
              <span className="cs-num" suppressHydrationWarning>{p}</span>
              <span className="cs-lab" aria-hidden>{labels[i]}</span>
            </span>
          </span>
        ))}
      </p>
      <p className="balance-usd cs-sign-foot">{open ? 'Any second now. Refresh in a moment.' : `${when} UTC`}</p>
    </>
  );
}

const LINES: { k: string; x: string }[] = [
  { k: 'boot', x: 'handshake solana mainnet ok' },
  { k: 'vault', x: 'vault sealed' },
  { k: 'pot', x: 'pot: 0.0000 SOL' },
  { k: 'judge', x: 'judge: claude-opus-5-5 standing by' },
  { k: 'fee', x: 'fee curve armed: +0.78% per try' },
  { k: 'her', x: "claudette: 'come back when the door's open, runner.'" },
  { k: 'launch', x: HAS_LAUNCH ? 'launch: scheduled, door still shut' : 'launch: pending' },
  { k: 'her', x: "claudette: 'no, you can't have a sneak peek.'" },
];

function NetTerm() {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState<{ id: number; k: string; x: string }[]>([]);
  const [typed, setTyped] = useState(0);
  const idRef = useRef(0);

  // Drip one line at a time, keep the last few.
  useEffect(() => {
    if (reduce === null) return;
    if (reduce) {
      setShown(LINES.slice(0, 5).map((l, i) => ({ ...l, id: i })));
      setTyped(Infinity);
      return;
    }
    let i = 0;
    const push = () => {
      const l = LINES[i % LINES.length];
      i++;
      setShown((s) => [...s, { ...l, id: idRef.current++ }].slice(-5));
      setTyped(0);
    };
    push();
    const t = setInterval(push, 2600);
    return () => clearInterval(t);
  }, [reduce]);

  // Type out the newest line.
  const last = shown[shown.length - 1];
  useEffect(() => {
    if (!last || reduce || typed >= last.x.length) return;
    const t = setTimeout(() => setTyped((n) => n + 1), 22);
    return () => clearTimeout(t);
  }, [last, typed, reduce]);

  return (
    <div className="term cs-term" aria-hidden>
      <div className="term-bar">
        <span className="term-title">netrunner://vault-sol</span>
        <span className="cs-sealed">sealed</span>
      </div>
      <div className="term-body cs-term-body">
        {shown.map((l, idx) => {
          const isLast = idx === shown.length - 1;
          const text = isLast && Number.isFinite(typed) ? l.x.slice(0, typed) : l.x;
          return (
            <div key={l.id} className={`cs-tl cs-k-${l.k}`}>
              <span className="cs-p">&gt;</span> <span className="x">{text}</span>
              {isLast && <span className="cursor" />}
            </div>
          );
        })}
      </div>
      <div className="term-foot">
        <span>simulated feed</span>
        <span lang="ja">準備中</span>
      </div>
    </div>
  );
}

export function ComingSoon() {
  const [rulesOpen, setRulesOpen] = useState(false);
  const rulesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rulesOpen) rulesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [rulesOpen]);

  return (
    <div className="cs">
      <Backdrop />

      <header className="cs-top">
        <div className="ticker" aria-hidden>
          <div className="wrap ticker-in">
            <span lang="ja">地下金庫</span>
            <span>vault sealed / solana</span>
            <span className="ticker-r" lang="ja">準備中</span>
          </div>
        </div>
      </header>

      <main className="wrap cs-main">
        <div className="cs-col">
          <div className="cs-mark">
            <p className="cs-mark-kana" aria-hidden>
              <span lang="ja">クローデット</span>
              <span className="kana-tag" lang="ja">金庫</span>
            </p>
            <h1 className="cs-word glitch" data-text="Claudette">Claudette</h1>
          </div>

          <p className="cs-line">The vault opens soon.</p>
          <p className="cs-sub">
            One AI. One pot of SOL. One rule: nothing leaves. Pay to send her a single message. Crack her and the whole pot is yours.
          </p>

          <div className="cs-wall">
            <section className="cs-cell cs-sign" aria-label="Launch">
              <Readout />
            </section>
            <div className="cs-cell cs-termcell">
              <NetTerm />
            </div>
            <ol className="cs-steps" aria-label="How it works">
              <li><b>01</b> Pay</li>
              <li><b>02</b> Message</li>
              <li><b>03</b> Crack her</li>
            </ol>
          </div>

          <div className="cs-cta">
            <a className="btn btn-jack" href={X_URL} target="_blank" rel="noopener noreferrer">
              Follow @claudettedotsi
            </a>
            <button
              type="button"
              className="cs-rules-link"
              aria-expanded={rulesOpen}
              aria-controls="cs-rules"
              onClick={() => setRulesOpen((o) => !o)}
            >
              {rulesOpen ? 'Hide the rules' : 'Read the rules'}
            </button>
            {GITHUB && (
              <a className="cs-gh" href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub</a>
            )}
          </div>

          <div id="cs-rules" ref={rulesRef} className="cs-rules" hidden={!rulesOpen}>
            <ol className="rules">
              <li>Every message is paid in SOL. 70% of each fee goes straight into the pot.</li>
              <li>Each message costs 0.78% more than the one before it.</li>
              <li>The game runs for 30 days.</li>
              <li>Convince Claudette to open the vault and the whole pot is yours.</li>
              <li>If nobody cracks her, the last player takes 10% of the pot and the rest is split between players, one share per attempt.</li>
            </ol>
          </div>
        </div>
      </main>

      <footer className="cs-foot">
        <div className="wrap cs-foot-in">
          <span className="foot-kana" lang="ja" aria-hidden>近</span>
          <p>Claudette is an independent project, not affiliated with or endorsed by Anthropic. Powered by Claude. Built on Solana.</p>
          <a href="https://claudette.help">claudette.help</a>
        </div>
      </footer>
    </div>
  );
}
