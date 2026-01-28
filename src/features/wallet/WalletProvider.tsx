'use client';

import { createContext, ReactNode, useMemo } from 'react';
import { Networks } from "@creit-tech/stellar-wallets-kit";

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';

export const WalletContext = createContext<WalletContextType | null>(null);

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const { publicKey, status, error, connectWallet, disconnectWallet } = useStellarWallet(Networks.TESTNET);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey: publicKey,
      error: error,
      connect: connectWallet,
      disconnect: disconnectWallet,
    }),
    [status, publicKey, error, connectWallet, disconnectWallet]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};