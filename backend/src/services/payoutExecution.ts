import {
  Address, BASE_FEE, Contract, Keypair, Transaction, TransactionBuilder, nativeToScVal, type Account,
} from "@stellar/stellar-sdk";
import type { PaymentConfig } from "../config/paymentConfig";
import type { CircuitBreaker } from "../utils/circuitBreaker";
import type { CreatePayoutRequest } from "../types/payment";

export interface Signer {
  sign(unsignedXdr: string): Promise<string | null>;
}

export interface Submitter {
  submit(signedTransaction: Transaction): Promise<{ status: string; hash: string }>;
}

export interface PayoutBuild {
  preparedTransaction: Transaction;
  amountStroops: string;
}

export interface PayoutBuilder {
  build(request: CreatePayoutRequest): Promise<PayoutBuild>;
}

export class SorobanSubmitter implements Submitter {
  constructor(private readonly rpcServer: { sendTransaction(tx: Transaction): Promise<{ status: string; hash: string }> }, private readonly breaker: CircuitBreaker) {}
  submit(signedTransaction: Transaction): Promise<{ status: string; hash: string }> {
    return this.breaker.fire(() => this.rpcServer.sendTransaction(signedTransaction));
  }
}

/** Current local signer. A remote/KMS signer can implement Signer without
 * exposing signing material to the payout orchestration service. */
export class LocalSecretSigner implements Signer {
  constructor(private readonly secret: string | undefined, private readonly networkPassphrase: string) {}
  async sign(unsignedXdr: string): Promise<string | null> {
    if (!this.secret) return null;
    const transaction = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    if (!(transaction instanceof Transaction)) throw new Error("Payout signer requires a transaction, not a fee bump");
    transaction.sign(Keypair.fromSecret(this.secret));
    return transaction.toXDR();
  }
}

export function createConfiguredSigner(config: PaymentConfig): Signer {
  return new LocalSecretSigner(config.hotSignerSecret, config.networkPassphrase);
}

export class StellarPayoutBuilder implements PayoutBuilder {
  constructor(
    private readonly config: PaymentConfig,
    private readonly rpcServer: { getAccount(account: string): Promise<unknown>; prepareTransaction(tx: Transaction): Promise<unknown> },
    private readonly breaker: CircuitBreaker,
  ) {}

  async build(request: CreatePayoutRequest): Promise<PayoutBuild> {
    const sourceAccount = await this.breaker.fire(() => this.rpcServer.getAccount(this.config.sourceAccount)) as Account;
    const amountStroops = toStroops(request.amount);
    const operation = new Contract(this.config.payoutContractId).call(
      this.config.payoutMethodName,
      new Address(request.arenaId).toScVal(),
      new Address(request.destinationAccount).toScVal(),
      nativeToScVal(BigInt(amountStroops), { type: "i128" }),
    );
    const built = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: this.config.networkPassphrase })
      .addOperation(operation).setTimeout(60).build();
    const preparedTransaction = await this.breaker.fire(() => this.rpcServer.prepareTransaction(built)) as Transaction;
    const feeStroops = Number(preparedTransaction.fee);
    if (!Number.isFinite(feeStroops) || feeStroops <= 0) throw new Error("Unable to determine prepared transaction fee");
    if (feeStroops > this.config.maxGasStroops) throw new Error(`Prepared transaction fee ${feeStroops} exceeds max gas ${this.config.maxGasStroops}`);
    return { preparedTransaction, amountStroops };
  }
}

export function toStroops(amount: string): string {
  const [wholePart, fractionPart = ""] = amount.split(".");
  const combined = `${wholePart}${(fractionPart + "0000000").slice(0, 7)}`.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(combined) || BigInt(combined) <= BigInt(0)) throw new Error("Amount must be greater than zero");
  return combined;
}
