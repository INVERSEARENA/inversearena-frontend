import { useState, useCallback } from 'react';
import { useWallet } from '@/features/wallet/useWallet';
import {
 TransactionStatus,
 ArenaTransaction,
} from '@/features/wallet/types';
import * as stellar from '@/shared-d/utils/stellar-transactions';

export const useArenaTransactions = () => {
 const { publicKey, signTransaction, submitTransaction } = useWallet();
 const [transaction, setTransaction] = useState<ArenaTransaction>({
  status: TransactionStatus.IDLE,
  txHash: null,
  error: null,
 });

 const executeTransaction = useCallback(
  async (
   buildFunction: (
    publicKey: string,
    ...args: any[]
   ) => Promise<string>,
   ...args: any[]
  ) => {
   if (!publicKey) {
    setTransaction({
     status: TransactionStatus.FAILED,
     txHash: null,
     error: new Error('Wallet not connected'),
    });
    return;
   }

   try {
    setTransaction({
     status: TransactionStatus.SIGNING,
     txHash: null,
     error: null,
    });
    const xdr = await buildFunction(publicKey, ...args);
    const signedXdr = await signTransaction(xdr);

    setTransaction({
     status: TransactionStatus.SUBMITTING,
     txHash: null,
     error: null,
    });
    const result = await submitTransaction(signedXdr);

    if (result.hash) {
     setTransaction({
      status: TransactionStatus.SUCCESS,
      txHash: result.hash,
      error: null,
     });
    } else {
     throw new Error('Transaction submission failed to return a hash');
    }
   } catch (e: any) {
    setTransaction({
     status: TransactionStatus.FAILED,
     txHash: null,
     error: e,
    });
   }
  },
  [publicKey, signTransaction, submitTransaction]
 );

 const joinArena = useCallback(
  (poolId: string) => {
   return executeTransaction(stellar.buildJoinArenaTransaction, poolId);
  },
  [executeTransaction]
 );

 const submitChoice = useCallback(
  (choice: 'heads' | 'tails') => {
   return executeTransaction(stellar.buildSubmitChoiceTransaction, choice);
  },
  [executeTransaction]
 );

 const claimWinnings = useCallback(
  (arenaId: string) => {
   return executeTransaction(stellar.buildClaimWinningsTransaction, arenaId);
  },
  [executeTransaction]
 );

 const reset = useCallback(() => {
  setTransaction({
   status: TransactionStatus.IDLE,
   txHash: null,
   error: null,
  });
 }, []);

 return { ...transaction, joinArena, submitChoice, claimWinnings, reset };
};
