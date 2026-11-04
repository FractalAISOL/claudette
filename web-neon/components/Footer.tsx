import { GITHUB_URL, X_URL } from '@/lib/config';

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <span className="foot-kana" lang="ja" aria-hidden>終</span>
        <p>Claudette is an independent project, not affiliated with or endorsed by Anthropic. Powered by Claude.</p>
        <div className="foot-links">
          <a href={X_URL} target="_blank" rel="noreferrer">X @claudettedotsi</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </div>
    </footer>
  );
}
