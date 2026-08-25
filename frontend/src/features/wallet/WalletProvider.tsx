'use client';

import { createContext, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';
import { stellarConfig } from '@/lib/stellarConfig';
import { Balance, fetchWalletBalance } from '@/shared-d/utils/stellar-balance';

export const WalletContext = createContext<WalletContextType | null>(null);

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const {
    publicKey,
    isConnected,
    status,
    error,
    connectWallet,
    disconnectWallet,
    signTransaction,
  } = useStellarWallet(stellarConfig.network);

  const [balance, setBalance] = useState<Balance>({ xlm: 0, usdc: 0 });
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    setIsLoadingBalance(true);
    try {
      setBalance(await fetchWalletBalance(publicKey));
    } catch (err) {
      console.error('Failed to fetch balances:', err);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (publicKey && status === 'connected') {
      void refreshBalance();
    } else {
      setBalance({ xlm: 0, usdc: 0 });
    }
  }, [publicKey, status, refreshBalance]);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey,
      address: publicKey,
      error,
      network: stellarConfig.network,
      isConnected,
      balance,
      isLoadingBalance,
      connect: () => connectWallet().then(() => {}),
      disconnect: disconnectWallet,
      signTransaction,
      refreshBalance,
    }),
    [
      status,
      publicKey,
      error,
      isConnected,
      balance,
      isLoadingBalance,
      connectWallet,
      disconnectWallet,
      signTransaction,
      refreshBalance,
    ]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};
