'use client';

import { MOCK } from '@/lib/config';
import { WalletButton } from './WalletButton';

export function Header() {
  return (
    <header className="top">
      <div className="ticker" aria-hidden>
        <div className="wrap ticker-in">
          <span lang="ja">地下金庫</span>
          <span>underground vault / solana / rain 94%</span>
          <span className="ticker-r" lang="ja">営業中</span>
        </div>
      </div>
      <div className="wrap top-in">
        <a href="#" className="mark" aria-label="Claudette, home">
          <span className="mark-kana" lang="ja" aria-hidden>クローデット</span>
          <span className="mark-word">Claudette</span>
        </a>
        <nav className="nav" aria-label="Main">
          {MOCK && <span className="mock-flag">Mock mode</span>}
          <a className="navlink" href="#play">Jack in</a>
          <a className="navlink" href="#ledger">Runs</a>
          <a
            className="navlink"
            href="#proof"
            onClick={(e) => {
              // On desktop the proof sits in the left column, not at the bottom.
              const side = document.getElementById('proof-side');
              if (side && side.offsetParent !== null) {
                e.preventDefault();
                side.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }}
          >
            Verify
          </a>
          <WalletButton />
        </nav>
      </div>
    </header>
  );
}
