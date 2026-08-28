import type { Balance } from '@/shared-d/utils/stellar-balance';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  publicKey: string | null;
  error: string | null;
}

export interface WalletContextType extends WalletState {
  /** Resolves with the connected public key, or null if connection failed. */
  connect: () => Promise<string | null>;
  disconnect: () => void;
  network: string;
  /** Alias of publicKey, kept for parity with the Freighter-direct wallet hook this replaces. */
  address: string | null;
  isConnected: boolean;
  balance: Balance;
  isLoadingBalance: boolean;
  /**
   * Non-null when the most recent balance lookup failed (e.g. Horizon outage
   * or rate-limit). `balance` then holds the last known value, not a zero
   * fallback — consumers should show a retry affordance. See #1295.
   */
  balanceError: string | null;
  signTransaction: (xdr: string) => Promise<string>;
  refreshBalance: () => Promise<void>;
}
