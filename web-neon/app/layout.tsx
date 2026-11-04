import type { Metadata, Viewport } from 'next';
import { Big_Shoulders, Chakra_Petch, Share_Tech_Mono, DotGothic16 } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

const display = Big_Shoulders({ subsets: ['latin'], variable: '--f-display', axes: ['opsz'], display: 'swap' });
const body = Chakra_Petch({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--f-body', display: 'swap' });
const mono = Share_Tech_Mono({ subsets: ['latin'], weight: '400', variable: '--f-mono', display: 'swap' });
const kana = DotGothic16({ subsets: ['latin'], weight: '400', variable: '--f-kana', display: 'swap', preload: false });

const COMING_SOON = process.env.NEXT_PUBLIC_COMING_SOON === '1' || process.env.NEXT_PUBLIC_COMING_SOON === 'true';
const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://claudette.help';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: 'Claudette guards the vault',
  description: 'Pay to send Claudette one message. She guards a SOL pot on Solana and must never give it away. Convince her and it is yours.',
  openGraph: { title: 'Claudette guards the vault', description: 'One message. One shot at the whole pot.', images: ['/claudette/og.jpg'] },
  twitter: { card: 'summary_large_image', site: '@claudettedotsi', images: ['/claudette/og.jpg'] },
};

export const viewport: Viewport = { themeColor: '#050307', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${kana.variable}`}>
      <body className={COMING_SOON ? 'is-soon' : undefined}>
        <div className="rain" aria-hidden />
        {/* Coming-soon mode skips Privy/react-query entirely: nothing touches a wallet or RPC. */}
        {COMING_SOON ? children : <Providers>{children}</Providers>}
      </body>
    </html>
  );
}
