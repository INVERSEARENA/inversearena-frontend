'use client';

import { createContext, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Networks } from '@creit-tech/stellar-wallets-kit';

import { WalletContextType } from './types';
import { useStellarWallet } from './useStellarWallet';
import { usePasskeyWallet } from './usePasskeyWallet';
import { isStellarConfigured, stellarConfig } from '@/lib/stellarConfig';
import { Balance, fetchWalletBalance } from '@/shared-d/utils/stellar-balance';

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
  const {
    publicKey: extensionPublicKey,
    isConnected: extensionIsConnected,
    status: extensionStatus,
    error: extensionError,
    connectWallet,
    disconnectWallet,
    signTransaction: signWithExtension,
  } = useStellarWallet(network);
  const passkey = usePasskeyWallet();

  // A passkey session takes precedence when active: a user can't be
  // connected via both an extension and a passkey at once, and passkey
  // registration already implies intent to use it. Every other consumer of
  // useWallet() (StakeModal, PoolCreationModal, admin gating, arena pages)
  // reads only through this merged context, so this is the single place
  // that decides which wallet "wins" (see #1281).
  const passkeyActive = passkey.isRegistered && passkey.address !== null;
  const publicKey = passkeyActive ? passkey.address : extensionPublicKey;
  const isConnected = passkeyActive ? true : extensionIsConnected;
  const status = passkeyActive ? 'connected' : extensionStatus;
  const error = passkeyActive ? null : extensionError;
  const signTransaction = passkeyActive ? passkey.sign : signWithExtension;

  const [balance, setBalance] = useState<Balance>({ xlm: 0, usdc: 0 });
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  // #1295 — when a balance lookup fails (Horizon outage / rate-limit) we must
  // NOT silently fall back to a zero balance: that makes every wallet look
  // empty and blocks legitimate stakes behind a misleading "Insufficient
  // balance" error. Surface the failure so the UI can offer a retry instead.
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    setIsLoadingBalance(true);
    setBalanceError(null);
    try {
      setBalance(await fetchWalletBalance(publicKey));
    } catch (err) {
      console.error('Failed to fetch balances:', err);
      setBalanceError(
        err instanceof Error
          ? err.message
          : 'Unable to load wallet balance. Please retry.',
      );
      // Deliberately leave `balance` at its last-known value rather than
      // zeroing it — a transient fetch failure shouldn't look like a drained
      // wallet.
    } finally {
      setIsLoadingBalance(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (publicKey && status === 'connected') {
      void refreshBalance();
    } else {
      setBalance({ xlm: 0, usdc: 0 });
      setBalanceError(null);
    }
  }, [publicKey, status, refreshBalance]);

  const disconnect = useCallback(() => {
    if (passkeyActive) {
      passkey.disconnect();
    } else {
      disconnectWallet();
    }
  }, [passkeyActive, passkey, disconnectWallet]);

  const contextValue: WalletContextType = useMemo(
    () => ({
      status,
      publicKey,
      address: publicKey,
      error,
      network,
      isConnected,
      balance,
      isLoadingBalance,
      balanceError,
      connect: connectWallet,
      disconnect: disconnectWallet,
      signTransaction,
      refreshBalance,
    }),
    [
      status,
      publicKey,
      error,
      network,
      isConnected,
      balance,
      isLoadingBalance,
      balanceError,
      connectWallet,
      disconnect,
      signTransaction,
      refreshBalance,
    ]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};
