import type { Balance } from '@/shared-d/utils/stellar-balance';

export type WalletStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'network-mismatch'
  | 'error';

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
  /**
   * Set only when status is 'network-mismatch': the human-readable name of
   * the network the connected wallet extension is actually active on, so
   * the UI can tell the user what they're on vs. what's expected.
   */
  walletNetworkName: string | null;
  /**
   * Re-checks the connected wallet's active network against the app's
   * configured network. Call after the user switches network inside their
   * extension to recover from a 'network-mismatch' state without a full
   * reconnect.
   */
  recheckNetwork: () => Promise<void>;
}
