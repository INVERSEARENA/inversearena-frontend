'use client';

import { createContext, ReactNode, useMemo } from 'react';
import { Networks } from '@creit-tech/stellar-wallets-kit';

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';
import { isStellarConfigured, stellarConfig } from '@/lib/stellarConfig';

export const WalletContext = createContext<WalletContextType | null>(null);

// WalletProvider wraps the whole app (via ClientProviders in the root
// layout), so it renders on every page — including ones with no Stellar
// dependency at all (home, profile, leaderboard). Reading stellarConfig.network
// unconditionally would trigger stellarConfig's lazy throw (#1134) on every
// single page load whenever Stellar isn't configured. Fall back to a plain
// Networks constant (not routed through stellarConfig) in that case; actual
// Soroban operations (e.g. signTransaction's use of stellarConfig.passphrase)
// still throw when genuinely attempted.
export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const network = isStellarConfigured ? stellarConfig.network : Networks.TESTNET;
  const { publicKey, status, error, connectWallet, disconnectWallet } = useStellarWallet(network);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey: publicKey,
      error,
      network,
      connect: () => connectWallet().then(() => {}),
      disconnect: disconnectWallet,
    }),
    [status, publicKey, error, connectWallet, disconnectWallet, network]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};
