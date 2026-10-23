'use client';

import { createContext, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Networks } from '@creit-tech/stellar-wallets-kit';

import { WalletContextType } from '../model/types';
import { useStellarWallet } from '../hooks/useStellarWallet';
import { usePasskeyWallet } from '../hooks/usePasskeyWallet';
import { isStellarConfigured, stellarConfig } from '@/shared/config/stellarConfig';
import { Balance } from '@/shared/lib/stellar/stellar-balance';
import { balanceCache, getWalletBalance } from '@/shared/lib/stellar/balance-cache';
import { usePageVisibility } from '@/shared/lib/hooks/usePageVisibility';
// Side-effect import: installs the single asset-readiness telemetry sink for
// the whole app. Every gate the provider renders — join, stake, claim — reports
// through it, so there is one place to change or disable the destination.
import '@/features/asset-readiness/api/install-asset-readiness-sink';

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
    walletNetworkName: extensionWalletNetworkName,
    connectWallet,
    disconnectWallet,
    signTransaction: signWithExtension,
    recheckNetwork: recheckExtensionNetwork,
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
  // Passkeys sign through the app's own backend/relayer rather than a
  // browser extension with its own independently-selectable network, so a
  // passkey session can never be in a 'network-mismatch' state (#1404).
  const status = passkeyActive ? 'connected' : extensionStatus;
  const error = passkeyActive ? null : extensionError;
  const walletNetworkName = passkeyActive ? null : extensionWalletNetworkName;
  const signTransaction = passkeyActive ? passkey.sign : signWithExtension;
  const recheckNetwork = useCallback(async () => {
    if (passkeyActive) return;
    await recheckExtensionNetwork();
  }, [passkeyActive, recheckExtensionNetwork]);

  const [balance, setBalance] = useState<Balance>({ xlm: 0, usdc: 0 });
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  // #1295 — when a balance lookup fails (Horizon outage / rate-limit) we must
  // NOT silently fall back to a zero balance: that makes every wallet look
  // empty and blocks legitimate stakes behind a misleading "Insufficient
  // balance" error. Surface the failure so the UI can offer a retry instead.
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const isVisible = usePageVisibility();

  // Apply a balance without re-rendering when nothing actually changed: the
  // shared cache notifies on every write, including background
  // revalidations that usually land on exactly the same numbers.
  const applyBalance = useCallback((next: Balance) => {
    setBalance((prev) => (prev.xlm === next.xlm && prev.usdc === next.usdc ? prev : next));
  }, []);

  /**
   * Read the wallet's balances through the shared cache (#1625).
   *
   * `force` re-reads from Horizon — an explicit user-triggered refresh must
   * always hit the network. Otherwise a still-fresh cached value is served
   * immediately and a stale one is served while it is revalidated in the
   * background, so the UI never blocks on Horizon for a number it already
   * knows.
   */
  const loadBalance = useCallback(
    async (force: boolean): Promise<void> => {
      if (!publicKey) return;
      setIsLoadingBalance(true);
      setBalanceError(null);
      try {
        applyBalance(await getWalletBalance(publicKey, { force }));
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
    },
    [publicKey, applyBalance],
  );

  const refreshBalance = useCallback(async () => {
    await loadBalance(true);
  }, [loadBalance]);

  useEffect(() => {
    if (publicKey && status === 'connected') {
      void loadBalance(false);
    } else {
      setBalance({ xlm: 0, usdc: 0 });
      setBalanceError(null);
    }
  }, [publicKey, status, loadBalance]);

  // Visibility-aware refresh (#1625): a wallet's balance can move while the
  // tab is in the background — a payment sent from another device, an
  // auto-compounding vault. Re-read when the tab comes back so the amount on
  // screen is not a snapshot of a hidden tab.
  useEffect(() => {
    if (!publicKey || status !== 'connected' || !isVisible) return;
    void loadBalance(false);
  }, [publicKey, status, isVisible, loadBalance]);

  // React to the shared cache's writes and invalidations for this wallet
  // (#1625). A confirmed transaction invalidates the cached balances, and the
  // revalidation that follows writes the new value — both arrive here, so
  // every consumer of the balance refreshes from one place instead of each
  // component polling Horizon on its own.
  useEffect(() => {
    if (!publicKey) return;
    return balanceCache.subscribe((event) => {
      if (event.publicKey !== publicKey) return;
      void loadBalance(false);
    });
  }, [publicKey, loadBalance]);

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
      disconnect,
      signTransaction,
      refreshBalance,
      walletNetworkName,
      recheckNetwork,
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
      walletNetworkName,
      recheckNetwork,
    ]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
};
