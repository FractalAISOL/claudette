'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { MOCK, PRIVY_APP_ID, PRIVY_CHAIN, RPC_URL } from '@/lib/config';

const wsUrl = (http: string) => http.replace(/^http/, 'ws');

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }));
  const [connectors] = useState(() => toSolanaWalletConnectors({ shouldAutoConnect: true }));
  const inner = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  if (MOCK || !PRIVY_APP_ID) return inner;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: 'dark', accentColor: '#ff1f3d', walletChainType: 'solana-only', walletList: ['phantom', 'solflare', 'backpack', 'detected_solana_wallets'] },
        loginMethods: ['wallet'],
        externalWallets: { solana: { connectors } },
        embeddedWallets: { solana: { createOnLogin: 'off' }, ethereum: { createOnLogin: 'off' } },
        solana: { rpcs: { [PRIVY_CHAIN]: { rpc: createSolanaRpc(RPC_URL), rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl(RPC_URL)) } } },
      }}
    >
      {inner}
    </PrivyProvider>
  );
}
