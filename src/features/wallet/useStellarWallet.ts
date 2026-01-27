import { ISupportedWallet, StellarWalletsKit, Networks } from "@creit-tech/stellar-wallets-kit";
import { FreighterModule } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { useEffect, useState, useCallback } from "react";

// Define an interface for the wallet hook's return type
export interface WalletHook {
  publicKey: string | null;
  isConnected: boolean;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
}

/**
 * Custom React hook for integrating Stellar Wallets Kit.
 * @param network The Stellar network to connect to (e.g., Networks.TESTNET, Networks.PUBLIC).
 * @returns An object containing the public key, connection status, and connection/disconnection functions.
 */
export const useStellarWallet = (network: Networks): WalletHook => {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  useEffect(() => {
    StellarWalletsKit.init({
      network: network,
      modules: [
        new xBullModule(),
        new FreighterModule(),
        new AlbedoModule()
      ],
    });
  }, [network]);

  const connectWallet = useCallback(async () => {
    try {
      const { address } = await StellarWalletsKit.authModal();
      setPublicKey(address);
      setIsConnected(true);
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      setIsConnected(false);
      setPublicKey(null);
    }
  }, []);

  const disconnectWallet = useCallback(() => {
    StellarWalletsKit.disconnect();
    setPublicKey(null);
    setIsConnected(false);
  }, []);

  return { publicKey, isConnected, connectWallet, disconnectWallet };
};

