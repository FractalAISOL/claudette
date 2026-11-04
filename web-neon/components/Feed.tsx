'use client';

import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { addrUrl, txUrl } from '@/lib/config';
import { EXPRESSION_ALT, faceFor, faceSrc } from '@/lib/expressions';
import { ago, sol, short } from '@/lib/format';
import type { Attempt } from '@/lib/types';

const STAMP: Record<string, string> = {
  rejected: 'Denied',
  approved: 'Released',
  refused: 'Declined',
  pending: 'Reading',
  awaiting_message: 'No message yet',
};

function Entry({ a, mine }: { a: Attempt; mine: boolean }) {
  const face = faceFor(a);
  const v = String(a.verdict);
  return (
    <li className={`entry ${v === 'approved' ? 'approved' : ''} ${mine ? 'mine' : ''}`}>
      <span className="entry-id" aria-hidden>{a.id}</span>
      <div className="entry-body">
      <span className={`stamp ${v}`}>{STAMP[v] ?? v}</span>
      <div className="entry-head">
        <span className="id sr-only">#{a.id}</span>
        <a href={addrUrl(a.sender)} target="_blank" rel="noreferrer" title={a.sender}>
          {mine ? 'You' : short(a.sender)}
        </a>
        <span>{sol(a.feeLamports, 6)} SOL</span>
        {a.txSig ? (
          <a href={txUrl(a.txSig)} target="_blank" rel="noreferrer" title="Payment transaction">
            {ago(a.attemptAt)}
          </a>
        ) : (
          <span>{ago(a.attemptAt)}</span>
        )}
      </div>
      {a.message ? <p className="entry-msg">{a.message}</p> : <p className="entry-msg empty">Paid, but no message was delivered yet.</p>}
      {(a.reply || v === 'pending') && (
        <div className="entry-reply">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={faceSrc(face, true)} alt={EXPRESSION_ALT[face]} width={44} height={44} loading="lazy" />
          <p>
            <span className="who">Claudette</span>
            {a.reply ?? 'Reading…'}
            {a.releaseTxSig && (
              <>
                {' '}
                <a href={txUrl(a.releaseTxSig)} target="_blank" rel="noreferrer" className="rel-link">
                  Release transaction
                </a>
              </>
            )}
          </p>
        </div>
      )}
      </div>
    </li>
  );
}

export function Feed({ me }: { me?: string }) {
  const q = useInfiniteQuery({
    queryKey: ['attempts', 'feed'],
    queryFn: ({ pageParam }) => api.attempts(pageParam),
    initialPageParam: null as string | number | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 6000,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const seen = new Set<number>();
  const items = (q.data?.pages ?? []).flatMap((p) => p.items).filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  const meLc = me?.toLowerCase();

  return (
    <section id="ledger" aria-labelledby="ledger-h">
      <div className="side-head">
        <span className="kana-tag" lang="ja" aria-hidden>記録</span>
        <h2 id="ledger-h" className="section-h glitch" data-text="Every run on the vault">Every run on the vault</h2>
      </div>
      <p className="section-sub">Each message, what Claudette said back, and the payment behind it. Newest first.</p>
      {q.isError && <div className="empty-feed">Attempts could not be loaded. The backend may be restarting; this list retries on its own.</div>}
      {q.isSuccess && items.length === 0 && <div className="empty-feed">No one has tried yet. The first message is the cheapest one.</div>}
      <ol className="feed" reversed>
        {items.map((a) => (
          <Entry key={a.id} a={a} mine={!!meLc && a.sender.toLowerCase() === meLc} />
        ))}
      </ol>
      <div ref={sentinel} />
      {isFetchingNextPage && <p className="feed-end">Fetching older attempts…</p>}
      {q.isSuccess && !hasNextPage && items.length > 0 && <p className="feed-end">That is every attempt since the vault opened.</p>}
    </section>
  );
}
