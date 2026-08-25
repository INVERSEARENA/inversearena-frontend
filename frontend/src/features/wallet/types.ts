import type { Balance } from '@/shared-d/utils/stellar-balance';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  publicKey: string | null;
  error: string | null;
}

export interface WalletContextType extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  network: string;
  /** Alias of publicKey, kept for parity with the Freighter-direct wallet hook this replaces. */
  address: string | null;
  isConnected: boolean;
  balance: Balance;
  isLoadingBalance: boolean;
  signTransaction: (xdr: string) => Promise<string>;
  refreshBalance: () => Promise<void>;
}
