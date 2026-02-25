import express from "express";
import { createApp } from "../../src/app";
import { PaymentService } from "../../src/services/paymentService";
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

export function setupTestApp() {
    const transactions = new MongoTransactionRepository();
    const paymentService = new PaymentService(transactions);
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
