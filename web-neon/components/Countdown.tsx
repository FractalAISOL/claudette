'use client';

import { useNow } from '@/lib/hooks';
import { countdownParts, pad2 } from '@/lib/format';

export function Countdown({ endTime }: { endTime?: number }) {
  const now = useNow(1000);
  if (!endTime) return <>…</>;
  const left = endTime - Math.floor(now / 1000);
  if (left <= 0) return <>Closed</>;
  const { d, h, m, s } = countdownParts(left);
  return (
    <span suppressHydrationWarning>
      {d}d {pad2(h)}:{pad2(m)}:{pad2(s)}
    </span>
  );
}
