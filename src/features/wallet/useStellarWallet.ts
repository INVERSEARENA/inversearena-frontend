import {
  ISupportedWallet,
  StellarWalletsKit,
  Networks,
} from '@creit-tech/stellar-wallets-kit';
import { FreighterModule } from '@creit-tech/stellar-wallets-kit/modules/freighter';
import { xBullModule } from '@creit-tech/stellar-wallets-kit/modules/xbull';
import { AlbedoModule } from '@creit-tech/stellar-wallets-kit/modules/albedo';
import { useEffect, useState, useCallback } from 'react';
import { SorobanRpc, Transaction } from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';

export interface WalletHook {
  publicKey: string | null;
  isConnected: boolean;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  submitTransaction: (
    signedXdr: string
  ) => Promise<SorobanRpc.Api.SendTransactionResponse>;
}

export const useStellarWallet = (network: Networks): WalletHook => {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);

  useEffect(() => {
    const newKit = new StellarWalletsKit({
      network: network,
      modules: [new xBullModule(), new FreighterModule(), new AlbedoModule()],
    });
    setKit(newKit);
  }, [network]);

  const connectWallet = useCallback(async () => {
    if (!kit) return;
    try {
      const pk = await kit.getPublicKey();
      setPublicKey(pk);
      setIsConnected(true);
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      setIsConnected(false);
      setPublicKey(null);
    }
  }, [kit]);

  const disconnectWallet = useCallback(() => {
    if (!kit) return;
    kit.disconnect();
    setPublicKey(null);
    setIsConnected(false);
  }, [kit]);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!kit || !publicKey) {
        throw new Error('Wallet not connected or kit not initialized.');
      }
      return kit.signTx(xdr, { pubkey: publicKey });
    },
    [kit, publicKey]
  );

  const submitTransaction = useCallback(
    async (
      signedXdr: string
    ): Promise<SorobanRpc.Api.SendTransactionResponse> => {
      const server = new SorobanRpc.Server(SOROBAN_RPC_URL, {
        allowHttp: true,
      });
      const tx = new Transaction(signedXdr, network);
      return server.sendTransaction(tx);
    },
    [network]
  );

  return {
    publicKey,
    isConnected,
    connectWallet,
    disconnectWallet,
    signTransaction,
    submitTransaction,
  };
};
