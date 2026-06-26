import "dotenv/config";
// import { db } from "./db/client";
import { redis } from "./cache/redisClient";
import { prisma } from "./db/prisma";
import { SqlTransactionRepository } from "./repositories/sqlTransactionRepository";
import { connectDB } from "./db/connection";
import { MongoTransactionRepository } from "./repositories/mongoTransactionRepository";
import { validateConfig } from "./config/validate";

import { PaymentService } from "./services/paymentService";
import { PaymentWorker } from "./workers/paymentWorker";
import { AdminService } from "./services/adminService";
import { AuthService } from "./services/authService";
import { RoundService } from "./services/roundService";
import { createTxQueue } from "./queues/txQueue";
import { startTxReconcilerWorker } from "./workers/txReconciler";
import { createApp } from "./app";

import { initSentry } from "./utils/sentry";
import { logger } from "./utils/logger";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  validateConfig();
  initSentry();
  await connectDB();
   await redis.connect();


  const transactions = new MongoTransactionRepository();

  const txQueue = createTxQueue();
  const paymentService = new PaymentService(transactions);
  const paymentWorker = new PaymentWorker(transactions, paymentService, txQueue);
  startTxReconcilerWorker(paymentService, transactions);
  const adminService = new AdminService();
  const authService = new AuthService();
  const roundService = new RoundService(prisma);

  const app = createApp({ 
    paymentService, 
    paymentWorker, 
    transactions, 
    adminService, 
    authService,
    roundService 
  });

  app.listen(PORT, () => {
    logger.info({ port: PORT }, "InverseArena backend listening");
  });
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
