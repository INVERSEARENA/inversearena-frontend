'use client';

import { createContext, ReactNode, useMemo } from 'react';
import { Networks } from "@creit-tech/stellar-wallets-kit";

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';

export const WalletContext = createContext<WalletContextType | null>(null);

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const { publicKey, isConnected, connectWallet, disconnectWallet } = useStellarWallet(Networks.TESTNET);

  const status = useMemo(() => {
    if (isConnected) {
      return 'connected';
    }
    // TODO: Add connecting and error states
    return 'disconnected';
  }, [isConnected]);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey: publicKey,
      error: null, // TODO: Handle errors
      connect: connectWallet,
      disconnect: disconnectWallet,
    }),
    [status, publicKey, connectWallet, disconnectWallet]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};