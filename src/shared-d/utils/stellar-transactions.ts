import {
  Keypair,
  TransactionBuilder,
  Operation,
  Networks,
  SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const server = new SorobanRpc.Server(SOROBAN_RPC_URL, { allowHttp: true });
const networkPassphrase = Networks.TESTNET;

// This is a placeholder for a real source account
// In a real app, you'd get this from the user's wallet
const tempSource = Keypair.random(); // In a real scenario, this would not be random

const getAccount = async (publicKey: string) => {
  try {
    return await server.getAccount(publicKey);
  } catch (e) {
    // If account is not found, we can't build a transaction from it.
    // This is a common issue in test environments.
    // For this mock, we'll log the error and proceed with a simulated source
    console.error(
      `Failed to fetch account ${publicKey}. This might be expected if the account does not exist on the network. Using a temporary account to build the transaction.`
    );
    // Return a dummy account structure for building purposes
    return {
      sequence: '0',
    } as any; // Using 'any' to mock the account response for build purposes
  }
};

const buildTransaction = async (
  publicKey: string,
  operation: xdr.Operation
) => {
  const source = await getAccount(publicKey);
  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  return tx.toXDR();
};

export const buildJoinArenaTransaction = async (
  publicKey: string,
  poolId: string
): Promise<string> => {
  console.log(`Building join arena transaction for pool: ${poolId}`);
  // Mock operation: send a memo
  const op = Operation.payment({
    destination: tempSource.publicKey(),
    asset: 'native' as any,
    amount: '1',
  });
  return buildTransaction(publicKey, op);
};

export const buildSubmitChoiceTransaction = async (
  publicKey: string,
  choice: 'heads' | 'tails'
): Promise<string> => {
  console.log(`Building submit choice transaction with choice: ${choice}`);
  // Mock operation: send a memo
  const op = Operation.payment({
    destination: tempSource.publicKey(),
    asset: 'native' as any,
    amount: '1',
  });
  return buildTransaction(publicKey, op);
};

export const buildClaimWinningsTransaction = async (
  publicKey: string,
  arenaId: string
): Promise<string> => {
  console.log(`Building claim winnings transaction for arena: ${arenaId}`);
  // Mock operation: send a memo
  const op = Operation.payment({
    destination: tempSource.publicKey(),
    asset: 'native' as any,
    amount: '1',
  });
  return buildTransaction(publicKey, op);
};
