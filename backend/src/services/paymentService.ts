import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { Api, Server } from "@stellar/stellar-sdk/rpc";
import { z } from "zod";

import { getPaymentConfig, type PaymentConfig } from "../config/paymentConfig";
import type { TransactionRepository } from "../repositories/transactionRepository";
import type {
  BuildPayoutResult,
  CreatePayoutRequest,
  SubmitResult,
  TransactionRecord,
} from "../types/payment";

const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const IDEMPOTENCY_REGEX = /^[a-zA-Z0-9:_-]{8,128}$/;
const AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/;

const CreatePayoutRequestSchema = z.object({
  payoutId: z.string().trim().min(1).max(128),
  destinationAccount: z
    .string()
    .trim()
    .regex(PUBLIC_KEY_REGEX, "Invalid Stellar destination account"),
  amount: z
    .string()
    .trim()
    .regex(AMOUNT_REGEX, "Amount must be a decimal with up to 7 digits"),
  asset: z.enum(["XLM", "USDC"]),
  idempotencyKey: z
    .string()
    .trim()
    .regex(IDEMPOTENCY_REGEX, "Invalid idempotency key format"),
});

function toStroops(amount: string): string {
  const [wholePart, fractionPart = ""] = amount.split(".");
  const padded = (fractionPart + "0000000").slice(0, 7);
  const combined = `${wholePart}${padded}`.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(combined)) {
    throw new Error("Amount contains invalid digits");
  }
  if (BigInt(combined) <= BigInt(0)) {
    throw new Error("Amount must be greater than zero");
  }
  return combined;
}

function generateRecordId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `tx_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function deriveResponseMode(status: TransactionRecord["status"]): BuildPayoutResult["mode"] {
  return status === "queued" ? "queued" : "build_only";
}

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface PaymentServiceOptions {
  config?: PaymentConfig;
  rpcServer?: Server;
}

export class PaymentService {
  private readonly config: PaymentConfig;
  private readonly rpcServer: Server;

  constructor(
    private readonly transactions: TransactionRepository,
    options: PaymentServiceOptions = {}
  ) {
    this.config = options.config ?? getPaymentConfig();
    this.rpcServer = options.rpcServer ?? new Server(this.config.sorobanRpcUrl);
  }

  async createPayoutTransaction(input: unknown): Promise<BuildPayoutResult> {
    const request = CreatePayoutRequestSchema.parse(input) as CreatePayoutRequest;

    const existing = await this.transactions.findByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      return {
        mode: deriveResponseMode(existing.status),
        transaction: existing,
        unsignedXdr: existing.unsignedXdr,
      };
    }

    const nonce = await this.transactions.reserveNextNonce(this.config.sourceAccount);
    const { preparedTransaction, amountStroops } = await this.buildPreparedTransaction(
      request,
      nonce
    );

    const unsignedXdr = preparedTransaction.toXDR();
    const now = new Date();

    let status: TransactionRecord["status"] = "built";
    let signedXdr: string | null = null;

    if (this.config.liveExecution) {
      if (this.config.signWithHotKey && this.config.hotSignerSecret) {
        preparedTransaction.sign(Keypair.fromSecret(this.config.hotSignerSecret));
        signedXdr = preparedTransaction.toXDR();
        status = "queued";
      } else {
        status = "awaiting_signature";
      }
    }

    const transaction: TransactionRecord = {
      id: generateRecordId(),
      payoutId: request.payoutId,
      idempotencyKey: request.idempotencyKey,
      sourceAccount: this.config.sourceAccount,
      destinationAccount: request.destinationAccount,
      asset: request.asset,
      amountStroops,
      nonce,
      status,
      unsignedXdr,
      signedXdr,
      txHash: null,
      errorMessage: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
    };

    await this.transactions.insert(transaction);

    return {
      mode: deriveResponseMode(status),
      transaction,
      unsignedXdr,
    };
  }

  async queueSignedTransaction(transactionId: string, signedXdr: string): Promise<TransactionRecord> {
    const transaction = await this.requireTransaction(transactionId);

    if (transaction.status !== "awaiting_signature" && transaction.status !== "built") {
      throw new Error(`Transaction ${transactionId} is not waiting for signature`);
    }

    TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);

    return this.transactions.update(transactionId, {
      signedXdr,
      status: "queued",
      errorMessage: null,
      updatedAt: new Date(),
    });
  }

  async submitQueuedTransaction(transactionId: string): Promise<SubmitResult> {
    const transaction = await this.requireTransaction(transactionId);

    if (transaction.status !== "queued") {
      return { transaction, submitted: false };
    }

    if (!this.config.liveExecution) {
      return { transaction, submitted: false };
    }

    if (!transaction.signedXdr) {
      const failed = await this.transactions.update(transaction.id, {
        status: "failed",
        errorMessage: "Missing signed XDR for queued transaction",
        updatedAt: new Date(),
      });
      return { transaction: failed, submitted: false };
    }

    if (transaction.attempts >= this.config.maxAttempts) {
      const failed = await this.transactions.update(transaction.id, {
        status: "failed",
        errorMessage: `Max submit attempts reached (${this.config.maxAttempts})`,
        updatedAt: new Date(),
      });
      return { transaction: failed, submitted: false };
    }

    const attempts = transaction.attempts + 1;

    try {
      const signedTransaction = TransactionBuilder.fromXDR(
        transaction.signedXdr,
        this.config.networkPassphrase
      );
      const sendResult = await this.rpcServer.sendTransaction(signedTransaction);

      if (sendResult.status === "ERROR") {
        const failed = await this.transactions.update(transaction.id, {
          attempts,
          status: "failed",
          txHash: sendResult.hash,
          errorMessage: "Soroban rejected transaction during submission",
          updatedAt: new Date(),
        });
        return { transaction: failed, submitted: false };
      }

      if (sendResult.status === "TRY_AGAIN_LATER") {
        const queued = await this.transactions.update(transaction.id, {
          attempts,
          errorMessage: "Soroban requested retry later",
          updatedAt: new Date(),
        });
        return { transaction: queued, submitted: false };
      }

      const submitted = await this.transactions.update(transaction.id, {
        attempts,
        status: "submitted",
        txHash: sendResult.hash,
        errorMessage: null,
        updatedAt: new Date(),
      });
      return { transaction: submitted, submitted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown submission failure";
      const failed = await this.transactions.update(transaction.id, {
        attempts,
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      });
      return { transaction: failed, submitted: false };
    }
  }

  async confirmSubmittedTransaction(transactionId: string): Promise<TransactionRecord> {
    const transaction = await this.requireTransaction(transactionId);

    if (transaction.status !== "submitted" || !transaction.txHash) {
      return transaction;
    }

    const onChain = await this.rpcServer.getTransaction(transaction.txHash);

    if (onChain.status === Api.GetTransactionStatus.SUCCESS) {
      return this.transactions.update(transaction.id, {
        status: "confirmed",
        confirmedAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      });
    }

    if (onChain.status === Api.GetTransactionStatus.FAILED) {
      return this.transactions.update(transaction.id, {
        status: "failed",
        errorMessage: "Transaction failed on-chain",
        updatedAt: new Date(),
      });
    }

    return transaction;
  }

  async pollConfirmation(transactionId: string): Promise<TransactionRecord> {
    let current = await this.requireTransaction(transactionId);

    for (let poll = 0; poll < this.config.confirmMaxPolls; poll += 1) {
      current = await this.confirmSubmittedTransaction(current.id);
      if (current.status === "confirmed" || current.status === "failed") {
        return current;
      }
      await delay(this.config.confirmPollMs);
    }

    return current;
  }

  private async requireTransaction(transactionId: string): Promise<TransactionRecord> {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }
    return transaction;
  }

  private async buildPreparedTransaction(request: CreatePayoutRequest, nonce: number) {
    const sourceAccount = await this.rpcServer.getAccount(this.config.sourceAccount);
    const contract = new Contract(this.config.payoutContractId);
    const amountStroops = toStroops(request.amount);

    const operation = contract.call(
      this.config.payoutMethodName,
      new Address(request.destinationAccount).toScVal(),
      nativeToScVal(BigInt(amountStroops), { type: "i128" }),
      nativeToScVal(request.asset),
      nativeToScVal(BigInt(nonce), { type: "u64" }),
      nativeToScVal(request.payoutId)
    );

    const built = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();

    const preparedTransaction = await this.rpcServer.prepareTransaction(built);

    const feeStroops = Number(preparedTransaction.fee);
    if (!Number.isFinite(feeStroops) || feeStroops <= 0) {
      throw new Error("Unable to determine prepared transaction fee");
    }
    if (feeStroops > this.config.maxGasStroops) {
      throw new Error(
        `Prepared transaction fee ${feeStroops} exceeds max gas ${this.config.maxGasStroops}`
      );
    }

    return {
      preparedTransaction,
      amountStroops,
    };
  }
}
