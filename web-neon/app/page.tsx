import { ComingSoon } from '@/components/ComingSoon';
import { Game } from '@/components/Game';

// NEXT_PUBLIC_COMING_SOON=1 swaps the game for a static teaser: no wallet, no API, no SSE.
const COMING_SOON = process.env.NEXT_PUBLIC_COMING_SOON === '1' || process.env.NEXT_PUBLIC_COMING_SOON === 'true';

export default function Page() {
  return COMING_SOON ? <ComingSoon /> : <Game />;
}
