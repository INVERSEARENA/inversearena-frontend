import "dotenv/config";
// import { db } from "./db/client";
import { redis } from "./cache/redisClient";
import { prisma } from "./db/prisma";
import { connectDB } from "./db/connection";
import { MongoTransactionRepository } from "./repositories/mongoTransactionRepository";
import { validateConfig } from "./config/validate";
import { getPaymentConfig } from "./config/paymentConfig";

import { PaymentService } from "./services/paymentService";
import { PaymentWorker } from "./workers/paymentWorker";
import { AdminService } from "./services/adminService";
import { AuthService } from "./services/authService";
import { RoundService } from "./services/roundService";
import { RoundProofBundleService } from "./services/roundProofBundleService";
import { createTxQueue } from "./queues/txQueue";
import { startTxReconcilerWorker } from "./workers/txReconciler";
import { createApp } from "./app";
import { shutdownApplication } from "./appLifecycle";
import { initLedgerContinuity } from "./services/ledgerContinuity";

import { initSentry } from "./utils/sentry";
import { logger } from "./utils/logger";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  validateConfig();
  initSentry();
  await connectDB();
   await redis.connect();
  // Restores any in-progress rollback recovery before workers/pollers publish (#1490).
  await initLedgerContinuity();

  const transactions = new MongoTransactionRepository();

  const txQueue = createTxQueue();
  const paymentService = new PaymentService(transactions);
  const paymentConfig = getPaymentConfig();
  const paymentWorker = new PaymentWorker(transactions, paymentService, txQueue, {
    failedRetryMax: paymentConfig.failedRetryMax,
    failedRetryBaseMs: paymentConfig.failedRetryBaseMs,
  });
  const reconciler = startTxReconcilerWorker(paymentService, transactions);
  const adminService = new AdminService();
  const authService = new AuthService();
  const roundService = new RoundService(prisma);
  const roundProofBundleService = new RoundProofBundleService(prisma);

  const app = createApp({
    paymentService,
    paymentWorker,
    transactions,
    adminService,
    authService,
    roundService,
    roundProofBundleService,
  });

  const httpServer = app.listen(PORT, () => {
    logger.info({ port: PORT }, "InverseArena backend listening");
  });
  const shutdown = () => void shutdownApplication({ httpServer, txQueue, stopWorkers: () => reconciler.close() }).catch((err) => {
    logger.error({ err }, "Failed to shut down backend cleanly");
    process.exitCode = 1;
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
