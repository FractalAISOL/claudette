'use client';

import { useCallback, useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { useConnectWallet, usePrivy } from '@privy-io/react-auth';
import { useSignAndSendTransaction, useWallets } from '@privy-io/react-auth/solana';
import { MOCK, PRIVY_APP_ID, PRIVY_CHAIN } from '@/lib/config';
import { short } from '@/lib/format';

export const MOCK_ADDRESS = 'C1aUdeTTe1111111111111111111111111111111111';

export interface Wallet {
  address: string | undefined;
  publicKey: PublicKey | undefined;
  isConnected: boolean;
  ready: boolean;
  /** Sign and send unsigned transaction bytes; resolves with the base58 signature. */
  send: (tx: Uint8Array) => Promise<string>;
  connect: () => void;
  disconnect: () => void;
}

const noop = () => {};
const MOCK_WALLET: Wallet = {
  address: MOCK_ADDRESS,
  publicKey: undefined,
  isConnected: true,
  ready: true,
  send: async () => {
    throw new Error('mock');
  },
  connect: noop,
  disconnect: noop,
};
const NO_PRIVY: Wallet = {
  address: undefined,
  publicKey: undefined,
  isConnected: false,
  ready: true,
  send: async () => {
    throw new Error('Wallets are not configured on this site.');
  },
  connect: noop,
  disconnect: noop,
};

function usePrivyWallet(): Wallet {
  const { ready, wallets } = useWallets();
  const { logout } = usePrivy();
  const { connectWallet } = useConnectWallet();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const w = wallets[0];
  const send = useCallback(
    async (tx: Uint8Array) => {
      if (!w) throw new Error('Connect a wallet first.');
      const { signature } = await signAndSendTransaction({ transaction: tx, wallet: w, chain: PRIVY_CHAIN });
      return bs58.encode(signature);
    },
    [w, signAndSendTransaction],
  );
  return useMemo(
    () => ({
      address: w?.address,
      publicKey: w ? new PublicKey(w.address) : undefined,
      isConnected: !!w,
      ready,
      send,
      connect: () => connectWallet({ walletChainType: 'solana-only' }),
      disconnect: () => {
        void w?.disconnect?.();
        void logout().catch(() => {});
      },
    }),
    [w, ready, send, connectWallet, logout],
  );
}

// MOCK and PRIVY_APP_ID are build-time constants, so the hook choice never changes between renders.
export const useWallet: () => Wallet = MOCK ? () => MOCK_WALLET : PRIVY_APP_ID ? usePrivyWallet : () => NO_PRIVY;

export function WalletButton({ variant = 'outline' }: { variant?: 'outline' | 'gold' | 'ink' }) {
  const w = useWallet();
  const cls = `btn btn-sm ${variant === 'gold' ? 'btn-gold' : variant === 'ink' ? 'btn-ink' : ''}`;
  if (MOCK) return <span className={cls} aria-label="Mock wallet">{short(w.address)}</span>;
  if (w.isConnected) {
    return (
      <button className={cls} onClick={w.disconnect} title="Disconnect">
        {short(w.address)}
      </button>
    );
  }
  return (
    <button className={cls} onClick={w.connect} disabled={!w.ready || !PRIVY_APP_ID}>
      {!PRIVY_APP_ID ? 'Wallets unavailable' : w.ready ? 'Connect wallet' : 'Loading…'}
    </button>
  );
}
