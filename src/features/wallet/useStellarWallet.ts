import { StellarWalletsKit, Networks } from "@creit-tech/stellar-wallets-kit";
import { FreighterModule } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { useEffect, useState, useCallback, useRef } from "react";
import { WalletStatus } from "./types";

// Define an interface for the wallet hook's return type
export interface WalletHook {
  publicKey: string | null;
  isConnected: boolean;
  status: WalletStatus;
  error: string | null;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
}

/**
 * Custom React hook for integrating Stellar Wallets Kit v2.
 * @param network The Stellar network to connect to (e.g., Networks.TESTNET, Networks.PUBLIC).
 * @returns An object containing the public key, connection status, error state, and connection/disconnection functions.
 */
export const useStellarWallet = (network: Networks): WalletHook => {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const kitRef = useRef<StellarWalletsKit | null>(null);

  // Initialize kit instance
  useEffect(() => {
    kitRef.current = new StellarWalletsKit({
      network: network,
      modules: [
        new xBullModule(),
        new FreighterModule(),
        new AlbedoModule()
      ],
    });
  }, [network]);

  const connectWallet = useCallback(async () => {
    if (!kitRef.current) {
      setError("Wallet kit not initialized");
      setStatus('error');
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
      let walletAddress: string | null = null;
      
      const result = await kitRef.current.openModal({
        onWalletSelected: async (option) => {
          kitRef.current?.setWallet(option.id);
          return option.id;
        },
        onClosed: () => {
          // User closed modal without selecting - reset to disconnected state
          setStatus('disconnected');
          setError(null);
        },
      });

      // Get address from modal result or fetch it after wallet is set
      if (result?.address) {
        walletAddress = result.address;
      } else if (kitRef.current) {
        // Fallback: get address from kit after wallet is selected
        try {
          const addressResult = await kitRef.current.getAddress();
          walletAddress = addressResult?.address || null;
        } catch (getAddressError) {
          console.error("Failed to get address:", getAddressError);
        }
      }

      if (walletAddress) {
        setPublicKey(walletAddress);
        setIsConnected(true);
        setStatus('connected');
        setError(null);
      } else {
        setStatus('disconnected');
        setError(null);
      }
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      
      // Format error message
      let errorMessage = "Failed to connect wallet";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      setError(errorMessage);
      setStatus('error');
      setIsConnected(false);
      setPublicKey(null);
    }
  }, []);

  const disconnectWallet = useCallback(() => {
    try {
      if (kitRef.current) {
        // Clear wallet from kit instance if method exists
        kitRef.current.setWallet(null);
      }
    } catch (error) {
      console.error("Error during disconnect:", error);
    }
    
    setPublicKey(null);
    setIsConnected(false);
    setStatus('disconnected');
    setError(null);
  }, []);

  return { publicKey, isConnected, status, error, connectWallet, disconnectWallet };
};

