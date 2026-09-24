import "dotenv/config";
import { redis } from "./cache/redisClient";
import { prisma } from "./db/prisma";
import { connectDB, mongoose } from "./db/connection";
import { MongoTransactionRepository } from "./repositories/mongoTransactionRepository";
import { validateConfig } from "./config/validate";
import { getPaymentConfig } from "./config/paymentConfig";
import { PaymentService } from "./services/paymentService";
import { PaymentWorker } from "./workers/paymentWorker";
import { AdminService } from "./services/adminService";
import { AuthService } from "./services/authService";
import { RoundService } from "./services/roundService";
import { BullMqQueueSnapshotSource, createTxQueue } from "./queues/txQueue";
import { startTxReconcilerWorker } from "./workers/txReconciler";
import { TransactionStateMachine } from "./services/transactionStateMachine";
import { getTxWorkerConfig } from "./config/workerConfig";
import { createApp } from "./app";
import { initSentry } from "./utils/sentry";
import { logger } from "./utils/logger";

const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  validateConfig();
  initSentry();
  await connectDB();
  await redis.connect();

  const transactions = new MongoTransactionRepository();
  const workerConfig = getTxWorkerConfig();
  const txQueue = createTxQueue();
  const queueSnapshotSource = new BullMqQueueSnapshotSource(
    txQueue,
    workerConfig.capacity,
  );
  const paymentService = new PaymentService(transactions);
  const paymentConfig = getPaymentConfig();
  const paymentWorker = new PaymentWorker(
    transactions,
    paymentService,
    txQueue,
    {
      failedRetryMax: paymentConfig.failedRetryMax,
      failedRetryBaseMs: paymentConfig.failedRetryBaseMs,
    },
  );
  const transactionStateMachine = new TransactionStateMachine(transactions);
  const txReconcilerWorker = startTxReconcilerWorker(
    paymentService,
    transactionStateMachine,
    { concurrency: workerConfig.concurrency },
  );

  const app = createApp({
    paymentService,
    paymentWorker,
    transactions,
    adminService: new AdminService(),
    authService: new AuthService(),
    roundService: new RoundService(prisma),
    queueSnapshotSource,
    queueCapacity: workerConfig.capacity,
  });
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "InverseArena backend listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down InverseArena backend");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([
      txReconcilerWorker.close(),
      txQueue.close(),
      mongoose.disconnect(),
      prisma.$disconnect(),
      redis.quit(),
    ]);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
