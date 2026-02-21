import { useState, useCallback, useEffect } from "react";
import {
  isConnected,
  requestAccess,
  getAddress,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import {
  AssetCodeSchema,
  HorizonAccountResponseSchema,
  NetworkPassphraseSchema,
  SignedXdrSchema,
  StellarPublicKeySchema,
} from "@/shared-d/utils/security-validation";

/**
 * Wallet connection status
 */
export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

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
  status: WalletStatus;
  address: string | null;
  error: string | null;
  isConnected: boolean;
  balance: Balance;
  isLoadingBalance: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string, network?: string) => Promise<string>;
  refreshBalance: () => Promise<void>;
}

/**
 * Fetch balance for a specific asset from Horizon
 */
async function fetchAssetBalance(publicKey: string, assetCode: "XLM" | "USDC"): Promise<number> {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedAssetCode = AssetCodeSchema.parse(assetCode);

  try {
    const res = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${validatedPublicKey}`
    );
    if (!res.ok) {
      return 0;
    }

    const rawData: unknown = await res.json();
    const data = HorizonAccountResponseSchema.parse(rawData);
    const balances = data.balances || [];

    if (validatedAssetCode === "XLM") {
      const nativeBalance = balances.find((balance) => balance.asset_type === "native");
      return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
    }

    const tokenBalance = balances.find(
      (balance) =>
        balance.asset_code === validatedAssetCode && balance.asset_type !== "native"
    );
    return tokenBalance ? parseFloat(tokenBalance.balance) : 0;
  } catch (err) {
    console.error(`Failed to fetch ${validatedAssetCode} balance:`, err);
    return 0;
  }
}

/**
 * Reusable wallet hook for managing wallet connection state
 */
export function useWallet(): UseWalletReturn {
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance>({ xlm: 0, usdc: 0 });
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  const refreshBalance = useCallback(async () => {
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
    } finally {
      setIsLoadingBalance(false);
    }
  }, [address]);

  useEffect(() => {
    async function checkConnection() {
      try {
        const connectionInfo = await isConnected();
        if (!connectionInfo?.isConnected) return;

        const addressInfo = await getAddress();
        if (!addressInfo?.address) return;

        const validatedAddress = StellarPublicKeySchema.parse(addressInfo.address);
        setAddress(validatedAddress);
        setStatus("connected");
      } catch (err) {
        console.error("Failed to check wallet connection:", err);
      }
    }

    void checkConnection();
  }, []);

  useEffect(() => {
    if (address && status === "connected") {
      void refreshBalance();
    }
  }, [address, status, refreshBalance]);

  const connect = useCallback(async () => {
    try {
      setStatus("connecting");
      setError(null);

      const connectionInfo = await isConnected();
      if (!connectionInfo?.isConnected) {
        throw new Error("Freighter wallet is not installed");
      }

      const accessInfo = await requestAccess();
      if (accessInfo.error) {
        throw new Error(accessInfo.error.toString());
      }
      if (!accessInfo?.address) {
        throw new Error("User rejected the connection");
      }

      const validatedAddress = StellarPublicKeySchema.parse(accessInfo.address);
      setAddress(validatedAddress);
      setStatus("connected");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to connect wallet";
      setError(errorMessage);
      setStatus("error");
      setAddress(null);
    }
  }, []);

  const disconnect = useCallback(() => {
    setStatus("disconnected");
    setAddress(null);
    setError(null);
    setBalance({ xlm: 0, usdc: 0 });
  }, []);

  const signTransaction = useCallback(async (xdr: string, network?: string) => {
    try {
      const validatedXdr = SignedXdrSchema.parse(xdr);
      const networkPassphrase = network
        ? NetworkPassphraseSchema.parse(network)
        : "Test SDF Network ; September 2015";

      const result = await freighterSignTransaction(validatedXdr, { networkPassphrase });
      if (result.error) {
        throw new Error(result.error.toString());
      }

      return SignedXdrSchema.parse(result.signedTxXdr);
    } catch (err) {
      console.error("Signing error:", err);
      throw err;
    }
  }, []);

  return {
    status,
    address,
    error,
    isConnected: status === "connected",
    balance,
    isLoadingBalance,
    connect,
    disconnect,
    signTransaction,
    refreshBalance,
  };
}

