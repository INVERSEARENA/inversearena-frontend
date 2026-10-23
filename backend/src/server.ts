import "dotenv/config";
// Validate the whole environment before any module below opens a connection (#1650).
import "./config/bootEnv";
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
import { OutboxStore } from "./services/outbox/outboxStore";
import { OutboxDispatcher, outboxPayloadObject } from "./workers/outboxDispatcher";
import { cache, invalidateArena, tags } from "./cache/cacheService";
import { publishArenaProjectionUpdate } from "./cache/arenaPoller";

import { initSentry } from "./utils/sentry";
import { logger } from "./utils/logger";
import { env } from "./config/env";

const PORT = Number(env.PORT ?? 3001);
const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

async function main() {
  validateConfig();
  initSentry();
  await connectDB();
  await redis.connect();
  const projectionStreamSubscriber = redis.duplicate();
  projectionStreamSubscriber.on("error", (err) => {
    logger.error({ err }, "Projection stream subscriber connection error");
  });
  projectionStreamSubscriber.on("pmessage", (_pattern, channel, rawMessage) => {
    try {
      const parsed: unknown = JSON.parse(rawMessage);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Projection stream message must be an object");
      }
      const update = parsed as Record<string, unknown>;
      if (
        typeof update.id !== "string" ||
        typeof update.dedupeKey !== "string" ||
        typeof update.arenaId !== "string" ||
        typeof update.network !== "string" ||
        typeof update.lastLedgerSequence !== "number" ||
        !Number.isInteger(update.lastLedgerSequence) ||
        typeof update.status !== "string" ||
        channel !== `arena:projection:${update.arenaId}`
      ) {
        throw new Error("Projection stream message has an invalid shape or channel");
      }
      publishArenaProjectionUpdate({
        id: update.id,
        dedupeKey: update.dedupeKey,
        arenaId: update.arenaId,
        network: update.network,
        lastLedgerSequence: update.lastLedgerSequence,
        status: update.status,
      });
    } catch (error) {
      logger.error({ channel, err: error }, "Discarded invalid projection stream message");
    }
  });
  await projectionStreamSubscriber.connect();
  await projectionStreamSubscriber.psubscribe("arena:projection:*");
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
  const outboxDispatcher = new OutboxDispatcher(
    new OutboxStore(prisma),
    async (message) => {
      const payload = outboxPayloadObject(message.payload);
      if (message.eventType === "arena.created") {
        const arenaId = payload.arenaId;
        if (typeof arenaId !== "string") {
          throw new Error(`Outbox event ${message.id} has no arenaId`);
        }
        await invalidateArena(arenaId);
        await cache.invalidate(tags.arenas());
        return;
      }
      if (message.eventType === "arena.projection.updated") {
        const arenaId = payload.arenaId;
        if (typeof arenaId !== "string") {
          throw new Error(`Outbox event ${message.id} has no arenaId`);
        }
        await redis.publish(`arena:projection:${arenaId}`, JSON.stringify({
          id: message.id,
          type: message.eventType,
          dedupeKey: message.dedupeKey,
          ...payload,
        }));
        return;
      }
      throw new Error(`Unsupported outbox event type: ${message.eventType}`);
    },
  );
  // #1391: reconciles the Arena table against the factory contract's
  // authoritative get_arenas state. Same env var confirmArenaDeployment
  // already requires — fail fast at boot rather than on first triggered run.
  const arenaFactoryContractId = env.ARENA_FACTORY_CONTRACT_ID ?? "";
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
  outboxDispatcher.start();
  const shutdown = () => void shutdownApplication({
    httpServer,
    txQueue,
    stopWorkers: async () => {
      await Promise.all([
        reconciler.close(),
        outboxDispatcher.stop(),
        projectionStreamSubscriber.quit(),
      ]);
    },
  }).catch((err) => {
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
