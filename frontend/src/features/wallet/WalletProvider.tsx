'use client';

import { createContext, ReactNode, useMemo } from 'react';

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';
import { stellarConfig } from '@/lib/stellarConfig';

export const WalletContext = createContext<WalletContextType | null>(null);

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const { publicKey, status, error, connectWallet, disconnectWallet } = useStellarWallet(stellarConfig.network);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey: publicKey,
      error,
      network: stellarConfig.network,
      connect: () => connectWallet().then(() => {}),
      disconnect: disconnectWallet,
    }),
    [status, publicKey, error, connectWallet, disconnectWallet]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};
