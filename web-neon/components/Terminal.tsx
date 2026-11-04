'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { txUrl } from '@/lib/config';
import { clock, short } from '@/lib/format';
import type { LogEvent } from '@/lib/types';

type Status = 'connecting' | 'live' | 'reconnecting' | 'offline';
const STATUS_LABEL: Record<Status, string> = { connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', offline: 'offline' };
const SIG = /([1-9A-HJ-NP-Za-km-z]{86,88})/g;

/** Turn any transaction signature in the text into an explorer link. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(SIG);
  return (
    <>
      {parts.map((p, i) =>
        /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(p) ? (
          <a key={i} href={txUrl(p)} target="_blank" rel="noreferrer">
            {short(p, 6)}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Map the backend's event kinds (attempt_seen, judge_start, release_sent…) onto the colour groups. */
function colourGroup(kind: string): string {
  if (kind === 'game_won') return 'won';
  if (kind.startsWith('watcher')) return 'boot';
  if (kind.startsWith('attempt')) return 'attempt';
  if (kind === 'message_received' || kind === 'hash_mismatch' || kind === 'no_message') return 'verify';
  if (kind.startsWith('judge') || kind === 'api_retry') return 'judge';
  if (kind.startsWith('release')) return 'release';
  if (kind.startsWith('game')) return 'timer';
  return kind;
}

function Line({ e }: { e: LogEvent }) {
  const approved = /APPROVED/.test(e.text) || (e.kind === 'verdict' && /\bapprov/i.test(e.text));
  return (
    <div className={`tl k-${colourGroup(e.kind)} l-${e.level}${approved ? ' v-approved' : ''}`}>
      <span className="t">{clock(e.ts)}</span>
      <span className="k">[{e.kind}]</span>
      <span className="x">
        <Linkified text={e.text} />
        {e.txSig && !e.text.includes(e.txSig) && (
          <>
            {' '}
            tx{' '}
            <a href={txUrl(e.txSig)} target="_blank" rel="noreferrer">
              {short(e.txSig, 6)}
            </a>
          </>
        )}
      </span>
    </div>
  );
}

export function Terminal({ lines, status, model, tall }: { lines: LogEvent[]; status: Status; model: string; tall?: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const paused = hover || scrolledUp;

  useEffect(() => {
    const el = body.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 40);
  };

  const jump = () => {
    setScrolledUp(false);
    setHover(false);
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="term" role="region" aria-label="Live log from Claudette’s server">
      <div className="term-bar">
        <span className="term-title">
          <b>netrunner@金庫</b>:~$ tail -f agent.log
        </span>
        <span className={`live ${status}`} aria-live="polite">
          <i aria-hidden />
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div
        ref={body}
        className="term-body"
        style={tall ? { height: '72vh' } : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onScroll={onScroll}
        tabIndex={0}
        aria-live="off"
      >
        {lines.length === 0 && <div className="tl l-debug"><span className="t">--:--:--</span><span className="k">[boot]</span><span className="x">waiting for the server…</span></div>}
        {lines.map((e, i) => (
          <Line key={String(e.id ?? i)} e={e} />
        ))}
        <span className="cursor" aria-hidden />
      </div>
      <div className="term-foot">
        <span>judge {model}</span>
        {paused ? <button onClick={jump}>Paused. Jump to latest</button> : <span>{lines.length} lines</span>}
      </div>
    </div>
  );
}

export function TerminalDock({ lines, status, model }: { lines: LogEvent[]; status: Status; model: string }) {
  const [open, setOpen] = useState(false);
  const last = lines[lines.length - 1];
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button className="dock" onClick={() => setOpen(true)} aria-label="Open the live log">
        <span className={`live ${status}`}>
          <i aria-hidden />
        </span>
        <span className="last">{last ? `[${last.kind}] ${last.text}` : 'live log'}</span>
        <span aria-hidden>▲</span>
      </button>
      {open && (
        <div className="sheet" role="dialog" aria-modal="true" aria-label="Live log" onClick={() => setOpen(false)}>
          <div className="sheet-in" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 12px 8px' }}>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Close</button>
            </div>
            <Terminal lines={lines} status={status} model={model} tall />
          </div>
        </div>
      )}
    </>
  );
}
