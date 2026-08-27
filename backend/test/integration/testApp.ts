import express from "express";
import { createApp } from "../../src/app";
import { PaymentService } from "../../src/services/paymentService";
import type { PaymentConfig } from "../../src/config/paymentConfig";
import { PaymentWorker } from "../../src/workers/paymentWorker";
import { AdminService } from "../../src/services/adminService";
import { AuthService } from "../../src/services/authService";
import { RoundService } from "../../src/services/roundService";
import { MongoTransactionRepository } from "../../src/repositories/mongoTransactionRepository";
import { prisma } from "../../src/db/prisma";

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

export function setupTestApp() {
    const transactions = new MongoTransactionRepository();
    const paymentService = new PaymentService(transactions, { config: TEST_PAYMENT_CONFIG });
    const paymentWorker = new PaymentWorker(transactions, paymentService, dummyTxQueue as any);
    const adminService = new AdminService();
    const authService = new AuthService();
    const roundService = new RoundService(prisma);

    const app = createApp({
        paymentService,
        paymentWorker,
        transactions,
        adminService,
        authService,
        roundService,
    });

    return app;
}
