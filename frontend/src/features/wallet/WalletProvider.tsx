'use client';

import { createContext, ReactNode, useMemo } from 'react';
import { Networks } from "@creit-tech/stellar-wallets-kit";

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';

/**
 * Resolve the Stellar network from the NEXT_PUBLIC_STELLAR_NETWORK env var.
 * Accepted values: "testnet" | "mainnet" (case-insensitive).
 * Defaults to TESTNET when the variable is missing or unrecognised.
 */
function getStellarNetwork(): Networks {
  const env = process.env.NEXT_PUBLIC_STELLAR_NETWORK?.toLowerCase();

  switch (env) {
    case 'mainnet':
      return Networks.PUBLIC;
    case 'testnet':
    case undefined:
    case '':
      return Networks.TESTNET;
    default:
      console.warn(
        `[WalletProvider] Unknown NEXT_PUBLIC_STELLAR_NETWORK="${process.env.NEXT_PUBLIC_STELLAR_NETWORK}", defaulting to TESTNET.`
      );
      return Networks.TESTNET;
  }
}

const resolvedNetwork = getStellarNetwork();

export const WalletContext = createContext<WalletContextType | null>(null);

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const { publicKey, status, error, connectWallet, disconnectWallet } = useStellarWallet(resolvedNetwork);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey: publicKey,
      error,
      network: resolvedNetwork,
      connect: connectWallet,
      disconnect: disconnectWallet,
    }),
    [status, publicKey, error, connectWallet, disconnectWallet]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};