import "dotenv/config";
import { db } from "./db/client";
import { SqlTransactionRepository } from "./repositories/sqlTransactionRepository";
import { PaymentService } from "./services/paymentService";
import { PaymentWorker } from "./workers/paymentWorker";
import { createApp } from "./app";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  await db.connect();
  console.log("Connected to PostgreSQL");

  const transactions = new SqlTransactionRepository(db);
  const paymentService = new PaymentService(transactions);
  const paymentWorker = new PaymentWorker(transactions, paymentService);

  const app = createApp({ paymentService, paymentWorker, transactions });

  app.listen(PORT, () => {
    console.log(`InverseArena backend listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
