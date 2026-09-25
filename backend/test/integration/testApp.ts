import express from "express";
import { createApp } from "../../src/app";
import { PaymentService } from "../../src/services/paymentService";
import type { PaymentConfig } from "../../src/config/paymentConfig";
import { PaymentWorker } from "../../src/workers/paymentWorker";
import { ArenaBackfillWorker } from "../../src/workers/arenaBackfillWorker";
import { AdminService } from "../../src/services/adminService";
import { AuthService } from "../../src/services/authService";
import { RoundService } from "../../src/services/roundService";
import { RoundProofBundleService } from "../../src/services/roundProofBundleService";
import { MongoTransactionRepository } from "../../src/repositories/mongoTransactionRepository";
import { InMemoryTransactionIntentRepository } from "../../src/repositories/inMemoryTransactionIntentRepository";
import { TransactionIntentService } from "../../src/services/transactionIntentService";
import { prisma } from "../../src/db/prisma";

const TEST_ARENA_FACTORY_CONTRACT_ID =
    "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

// Dummy memory tx queue for testing
const dummyTxQueue = {
    add: jest.fn(),
    process: jest.fn(),
    obliterate: jest.fn(),
    addBulk: jest.fn(),
};

const TEST_PAYMENT_CONFIG: PaymentConfig = {
    liveExecution: false,
    signWithHotKey: false,
    maxGasStroops: 2_000_000,
    maxAttempts: 5,
    confirmPollMs: 1,
    confirmMaxPolls: 3,
    failedRetryMax: 3,
    failedRetryBaseMs: 5000,
    payoutMethodName: "distribute_winnings",
    payoutContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    sourceAccount: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    hotSignerSecret: undefined,
    networkPassphrase: "Test SDF Network ; September 2015",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
};

export function setupTestApp(overrides: { roundService?: RoundService } = {}) {
    const transactions = new MongoTransactionRepository();
    const paymentService = new PaymentService(transactions, { config: TEST_PAYMENT_CONFIG });
    const paymentWorker = new PaymentWorker(transactions, paymentService, dummyTxQueue as any);
    const arenaBackfillWorker = new ArenaBackfillWorker(prisma, TEST_ARENA_FACTORY_CONTRACT_ID);
    const adminService = new AdminService();
    const authService = new AuthService();
    const roundService = overrides.roundService ?? new RoundService(prisma);
    const roundProofBundleService = new RoundProofBundleService(prisma, {
        sorobanRpcUrl: TEST_PAYMENT_CONFIG.sorobanRpcUrl,
        networkPassphrase: TEST_PAYMENT_CONFIG.networkPassphrase,
        roundConfirmPollMs: 1,
        roundConfirmMaxPolls: 3,
    });
    const transactionIntentService = new TransactionIntentService(new InMemoryTransactionIntentRepository());

    const app = createApp({
        paymentService,
        paymentWorker,
        arenaBackfillWorker,
        transactions,
        adminService,
        authService,
        roundService,
        roundProofBundleService,
        transactionIntentService,
    });

    return app;
}
