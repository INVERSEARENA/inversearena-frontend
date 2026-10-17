import { StellarWalletsKit, Networks } from "@creit-tech/stellar-wallets-kit";
import { FreighterModule } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { useEffect, useState, useCallback, useRef } from "react";
import { WalletStatus } from "./types";
import { SignedXdrSchema } from "@/shared-d/utils/security-validation";
import { isStellarConfigured, stellarConfig } from "@/lib/stellarConfig";

// Define an interface for the wallet hook's return type
export interface WalletHook {
  publicKey: string | null;
  isConnected: boolean;
  status: WalletStatus;
  error: string | null;
  /** Set only when status is 'network-mismatch': the wallet's actual active network name. */
  walletNetworkName: string | null;
  connectWallet: () => Promise<string | null>;
  signTransaction: (xdr: string) => Promise<string>;
  disconnectWallet: () => void;
  /** Re-checks the connected wallet's active network without a full reconnect. */
  recheckNetwork: () => Promise<void>;
}

// Stellar public keys start with G and are exactly 56 alphanumeric (base32) characters.
const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

// Key used to persist intentional disconnect so wallet extensions can't phantom-reconnect.
export const WALLET_DISCONNECTED_KEY = 'inversearena:wallet:disconnected';

const KIT_MODULES = () => [new xBullModule(), new FreighterModule(), new AlbedoModule()];

export function isValidStellarPublicKey(address: string): boolean {
  return STELLAR_PUBLIC_KEY_REGEX.test(address);
}

/**
 * Custom React hook for integrating Stellar Wallets Kit.
 * @param network The Stellar network to connect to (e.g., Networks.TESTNET, Networks.PUBLIC).
 * @returns An object containing the public key, connection status, and connection/disconnection functions.
 */
export const useStellarWallet = (network: Networks): WalletHook => {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [walletNetworkName, setWalletNetworkName] = useState<string | null>(null);
  const kitInitializedRef = useRef(false);
  const connectAttemptRef = useRef(0);
  const currentNetworkRef = useRef(network);

  // The app's expected passphrase. When Stellar isn't configured at all
  // there's nothing to mismatch against, so network checks are skipped
  // entirely (matches the rest of the app's isStellarConfigured guard, #1134).
  const expectedPassphrase = isStellarConfigured ? stellarConfig.passphrase : null;

  // Queries the connected wallet extension's actual active network (not the
  // app's configured one) and compares it against expectedPassphrase. A
  // mismatch (e.g. Freighter set to Public while the app expects Testnet)
  // is put into a distinct 'network-mismatch' status rather than
  // 'connected', since signing would otherwise fail unpredictably or sign
  // against the wrong network.
  const checkNetwork = useCallback(async (): Promise<boolean> => {
    if (!expectedPassphrase) return true;
    try {
      const { networkPassphrase } = await StellarWalletsKit.getNetwork();
      if (networkPassphrase === expectedPassphrase) {
        setWalletNetworkName(null);
        return true;
      }
      setWalletNetworkName(networkPassphrase);
      return false;
    } catch (err) {
      // A wallet that can't report its network (e.g. Albedo, which has no
      // getNetwork support) can't be checked; treat as matching rather than
      // blocking a wallet type that was never mismatched to begin with.
      console.warn('Unable to read wallet network:', err);
      setWalletNetworkName(null);
      return true;
    }
  }, [expectedPassphrase]);

  useEffect(() => {
    if (currentNetworkRef.current !== network) {
      currentNetworkRef.current = network;
      setPublicKey(null);
      setIsConnected(false);
      setStatus('disconnected');
      setError(null);
    }
    // Suppress auto-reconnect if the user previously disconnected intentionally:
    // skip initializing the kit entirely so it never attempts to restore the
    // last session. connectWallet() will initialize it lazily on demand.
    const suppressAutoReconnect =
      typeof window !== 'undefined' && localStorage.getItem(WALLET_DISCONNECTED_KEY) === 'true';

    if (suppressAutoReconnect) {
      kitInitializedRef.current = false;
      return;
    }

    StellarWalletsKit.init({
      network: network,
      modules: KIT_MODULES(),
    });
    kitInitializedRef.current = true;

    return () => {
      connectAttemptRef.current += 1;
      StellarWalletsKit.disconnect();
    };
  }, [network]);

  const connectWallet = useCallback(async () => {
    const attempt = ++connectAttemptRef.current;
    try {
      setStatus('connecting');
      setError(null);
      // Clear intentional-disconnect flag so the session is treated as fresh
      if (typeof window !== 'undefined') {
        localStorage.removeItem(WALLET_DISCONNECTED_KEY);
      }
      // The mount effect skips StellarWalletsKit.init() when auto-reconnect
      // was suppressed; initialize it now that the user explicitly connected.
      if (!kitInitializedRef.current) {
        StellarWalletsKit.init({ network, modules: KIT_MODULES() });
        kitInitializedRef.current = true;
      }
      const { address } = await StellarWalletsKit.authModal();

      // A disconnect, network change, or newer connect request supersedes this result.
      if (attempt !== connectAttemptRef.current) return null;

      if (!isValidStellarPublicKey(address)) {
        setIsConnected(false);
        setPublicKey(null);
        setStatus('error');
        setError('Wallet returned an invalid public key. Please try reconnecting.');
        return null;
      }

      setPublicKey(address);
      setIsConnected(true);

      const networkMatches = await checkNetwork();
      if (!networkMatches) {
        // Deliberately still "connected" in the sense that publicKey/isConnected
        // are set (disconnect/reconnect isn't needed to recover), but status
        // is 'network-mismatch' so callers relying on status === 'connected'
        // (e.g. signing flows) correctly treat this as not ready to sign.
        setStatus('network-mismatch');
        setError(null);
        return address;
      }

      setStatus('connected');
      return address;
    } catch (err) {
      if (attempt !== connectAttemptRef.current) return null;
      console.error("Failed to connect wallet:", err);
      setIsConnected(false);
      setPublicKey(null);
      setStatus('error');
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
      return null;
    }
  }, [network, checkNetwork]);

  // Recovery path for #1404: re-checks the wallet's active network without a
  // full disconnect/reconnect, so a user who switches network inside their
  // extension (e.g. Freighter) can resume where they left off.
  const recheckNetwork = useCallback(async () => {
    if (!isConnected) return;
    const networkMatches = await checkNetwork();
    setStatus(networkMatches ? 'connected' : 'network-mismatch');
    if (networkMatches) setError(null);
  }, [isConnected, checkNetwork]);

  const signTransaction = useCallback(async (xdr: string) => {
    const walletAddress = publicKey ?? (await StellarWalletsKit.getAddress()).address;

    if (!walletAddress) {
      throw new Error("Wallet is not connected");
    }

    // Re-verify right before signing rather than trusting stale state: the
    // user may have switched their extension's network after connecting
    // (or after a prior recheckNetwork() call) without touching this app.
    const networkMatches = await checkNetwork();
    if (!networkMatches) {
      setStatus('network-mismatch');
      throw new Error(
        'Your wallet is connected to a different network than this app. Switch your wallet network and try again.',
      );
    }

    const validatedXdr = SignedXdrSchema.parse(xdr);
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(validatedXdr, {
      address: walletAddress,
      networkPassphrase: stellarConfig.passphrase,
    });

    return SignedXdrSchema.parse(signedTxXdr);
  }, [publicKey, checkNetwork]);

  const disconnectWallet = useCallback(() => {
    connectAttemptRef.current += 1;
    StellarWalletsKit.disconnect();
    setPublicKey(null);
    setIsConnected(false);
    setStatus('disconnected');
    setError(null);
    setWalletNetworkName(null);
    // Persist intentional disconnect so extensions cannot phantom-reconnect on reload
    if (typeof window !== 'undefined') {
      localStorage.setItem(WALLET_DISCONNECTED_KEY, 'true');
    }
  }, []);

  return {
    publicKey,
    isConnected,
    status,
    error,
    walletNetworkName,
    connectWallet,
    signTransaction,
    disconnectWallet,
    recheckNetwork,
  };
};
