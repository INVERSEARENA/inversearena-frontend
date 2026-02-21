export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  publicKey: string | null;
  error: string | null;
}

export interface WalletContextType extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
}