import { SorobanRpc } from '@stellar/stellar-sdk';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  publicKey: string | null;
  error: string | null;
}

export interface WalletContextType extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  submitTransaction: (
    signedXdr: string
  ) => Promise<SorobanRpc.Api.SendTransactionResponse>;
}

export enum TransactionStatus {
  IDLE = 'idle',
  SIGNING = 'signing',
  SUBMITTING = 'submitting',
  SUCCESS = 'success',
  FAILED = 'failed',
}
 
export interface ArenaTransaction {
  status: TransactionStatus;
  txHash: string | null;
  error: Error | null;
}