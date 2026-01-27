import { useState, useCallback, useEffect } from 'react';
import { isConnected, requestAccess, getAddress, signTransaction as freighterSignTransaction } from '@stellar/freighter-api';

/**
 * Wallet connection status
 */
export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Balance information for a currency
 */
export interface Balance {
  xlm: number;
  usdc: number;
}

/**
 * Wallet hook return type
 */
export interface UseWalletReturn {
  /** Current connection status */
  status: WalletStatus;
  /** Connected wallet address (null if not connected) */
  address: string | null;
  /** Error message (null if no error) */
  error: string | null;
  /** Derived boolean for convenience */
  isConnected: boolean;
  /** Wallet balances */
  balance: Balance;
  /** Whether balances are being fetched */
  isLoadingBalance: boolean;
  /** Connect to wallet */
  connect: () => Promise<void>;
  /** Disconnect from wallet */
  disconnect: () => void;
  /** Sign a transaction XDR */
  signTransaction: (xdr: string, network?: string) => Promise<string>;
  /** Fetch wallet balances */
  fetchBalance: () => Promise<void>;
}

// Contract IDs for balance fetching
const XLM_CONTRACT_ID = "CAS3J7GYLGXMF6TDJBXBGMELNUPVCGXIZ68TZE6GTVASJ63Y32KXVY77"; // Testnet Native SAC
const USDC_CONTRACT_ID = "CC..."; // TODO: Add real USDC Contract ID

/**
 * Fetch balance for a specific asset from Horizon
 */
async function fetchAssetBalance(publicKey: string, assetCode: string): Promise<number> {
  try {
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${publicKey}`);
    if (!res.ok) {
      return 0;
    }
    const data = await res.json();

    // Find the balance for the specific asset
    const balances = data.balances || [];

    if (assetCode === "XLM") {
      // Native balance
      const nativeBalance = balances.find((b: any) => b.asset_type === "native");
      return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
    } else {
      // Token balance (USDC)
      const tokenBalance = balances.find(
        (b: any) => b.asset_code === assetCode && b.asset_type !== "native"
      );
      return tokenBalance ? parseFloat(tokenBalance.balance) : 0;
    }
  } catch (err) {
    console.error(`Failed to fetch ${assetCode} balance:`, err);
    return 0;
  }
}

/**
 * Reusable wallet hook for managing wallet connection state
 */
export function useWallet(): UseWalletReturn {
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance>({ xlm: 0, usdc: 0 });
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  const fetchBalance = useCallback(async () => {
    if (!address) return;

    setIsLoadingBalance(true);
    try {
      const [xlmBalance, usdcBalance] = await Promise.all([
        fetchAssetBalance(address, "XLM"),
        fetchAssetBalance(address, "USDC"),
      ]);

      setBalance({ xlm: xlmBalance, usdc: usdcBalance });
    } catch (err) {
      console.error("Failed to fetch balances:", err);
      // Keep previous balance on error
    } finally {
      setIsLoadingBalance(false);
    }
  }, [address]);

  // Check if wallet is already connected on mount
  useEffect(() => {
    async function checkConnection() {
      try {
        const connectionInfo = await isConnected();
        if (connectionInfo?.isConnected) {
          const addressInfo = await getAddress();
          if (addressInfo?.address) {
            setAddress(addressInfo.address);
            setStatus('connected');
          }
        }
      } catch (err) {
        console.error('Failed to check wallet connection:', err);
      }
    }
    checkConnection();
  }, []);

  // Fetch balance when address changes (wallet connected)
  useEffect(() => {
    if (address && status === 'connected') {
      fetchBalance();
    }
  }, [address, status, fetchBalance]);

  const connect = useCallback(async () => {
    try {
      setStatus('connecting');
      setError(null);

      const connectionInfo = await isConnected();
      if (!connectionInfo?.isConnected) {
        // Freighter not installed
        throw new Error('Freighter wallet is not installed');
      }

      // Request access
      const accessInfo = await requestAccess();

      if (accessInfo.error) {
        throw new Error(accessInfo.error.toString());
      }

      if (!accessInfo?.address) {
        throw new Error('User rejected the connection');
      }

      setAddress(accessInfo.address);
      setStatus('connected');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(errorMessage);
      setStatus('error');
      setAddress(null);
    }
  }, []);

  const disconnect = useCallback(() => {
    // Freighter doesn't have a strict disconnect API for dApps (it's stateless mostly),
    // but we clear our local state.
    setStatus('disconnected');
    setAddress(null);
    setError(null);
    setBalance({ xlm: 0, usdc: 0 });
  }, []);

  const signTransaction = useCallback(async (xdr: string, network?: string) => {
    try {
      const networkPassphrase = network || "Test SDF Network ; September 2015"; // Default to Testnet
      const result = await freighterSignTransaction(xdr, { networkPassphrase });

      if (result.error) {
        throw new Error(result.error.toString());
      }

      return result.signedTxXdr;
    } catch (err) {
      console.error("Signing error:", err);
      throw err;
    }
  }, []);

  return {
    status,
    address,
    error,
    isConnected: status === 'connected',
    balance,
    isLoadingBalance,
    connect,
    disconnect,
    signTransaction,
    fetchBalance,
  };
}
