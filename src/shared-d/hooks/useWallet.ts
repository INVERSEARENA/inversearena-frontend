import { useState, useCallback, useEffect } from 'react';
import { isConnected, requestAccess, getAddress, signTransaction as freighterSignTransaction } from '@stellar/freighter-api';

/**
 * Wallet connection status
 */
export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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
  /** Connect to wallet */
  connect: () => Promise<void>;
  /** Disconnect from wallet */
  disconnect: () => void;
  /** Sign a transaction XDR */
  signTransaction: (xdr: string, network?: string) => Promise<string>;
}

/**
 * Reusable wallet hook for managing wallet connection state
 */
export function useWallet(): UseWalletReturn {
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    connect,
    disconnect,
    signTransaction,
  };
}
