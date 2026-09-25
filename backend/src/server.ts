import "dotenv/config";
// import { db } from "./db/client";
import { redis } from "./cache/redisClient";
import { prisma } from "./db/prisma";
import { connectDB } from "./db/connection";
import { MongoTransactionRepository } from "./repositories/mongoTransactionRepository";
import { MongoTransactionIntentRepository } from "./repositories/mongoTransactionIntentRepository";
import { validateConfig } from "./config/validate";
import { getPaymentConfig } from "./config/paymentConfig";

import { PaymentService } from "./services/paymentService";
import { PaymentWorker } from "./workers/paymentWorker";
import { ArenaBackfillWorker } from "./workers/arenaBackfillWorker";
import { AdminService } from "./services/adminService";
import { AuthService } from "./services/authService";
import { RoundService } from "./services/roundService";
import { RoundProofBundleService } from "./services/roundProofBundleService";
import { TransactionIntentService } from "./services/transactionIntentService";
import { createTxQueue } from "./queues/txQueue";
import { startTxReconcilerWorker } from "./workers/txReconciler";
import { createApp } from "./app";
import { shutdownApplication } from "./appLifecycle";
import { initLedgerContinuity } from "./services/ledgerContinuity";

import { initSentry } from "./utils/sentry";
import { logger } from "./utils/logger";

const PORT = Number(process.env.PORT ?? 3001);
const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

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
  const transactionIntentService = new TransactionIntentService(new MongoTransactionIntentRepository());

  // #1391: reconciles the Arena table against the factory contract's
  // authoritative get_arenas state. Same env var confirmArenaDeployment
  // already requires — fail fast at boot rather than on first triggered run.
  const arenaFactoryContractId = process.env.ARENA_FACTORY_CONTRACT_ID ?? "";
  if (!CONTRACT_ID_REGEX.test(arenaFactoryContractId)) {
    throw new Error(
      "ARENA_FACTORY_CONTRACT_ID is not configured with a valid Soroban contract ID",
    );
  }
  const arenaBackfillWorker = new ArenaBackfillWorker(prisma, arenaFactoryContractId);

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
