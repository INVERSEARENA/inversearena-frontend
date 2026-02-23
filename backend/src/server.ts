import "dotenv/config";
import { db } from "./db/client";
import { redis } from "./cache/redisClient";
import { prisma } from "./db/prisma";
import { SqlTransactionRepository } from "./repositories/sqlTransactionRepository";
import { connectDB } from "./db/connection";
import { MongoTransactionRepository } from "./repositories/mongoTransactionRepository";

import { PaymentService } from "./services/paymentService";
import { PaymentWorker } from "./workers/paymentWorker";
import { AdminService } from "./services/adminService";
import { AuthService } from "./services/authService";
import { RoundService } from "./services/roundService";
import { createApp } from "./app";

import { initSentry } from "./utils/sentry";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  initSentry();
  await connectDB();
  await redis.connect();


  const transactions = new MongoTransactionRepository();

  const paymentService = new PaymentService(transactions);
  const paymentWorker = new PaymentWorker(transactions, paymentService);
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
    console.log(`InverseArena backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
