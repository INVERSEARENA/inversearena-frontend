import type { Server } from "http";
import type { Queue } from "bullmq";
import { logger } from "./utils/logger";
import { prisma } from "./db/prisma";
import { mongoose } from "./db/connection";
import { redis } from "./cache/redisClient";

export interface ApplicationResources {
  httpServer: Server;
  txQueue?: Queue;
  stopWorkers?: () => Promise<void>;
}

let shuttingDown = false;

/** Owns shutdown ordering; startup wiring remains in index.ts. */
export async function shutdownApplication(resources: ApplicationResources): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    resources.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await resources.stopWorkers?.();
  await resources.txQueue?.close();
  await Promise.allSettled([redis.quit(), prisma.$disconnect(), mongoose.disconnect()]);
  logger.info("InverseArena backend stopped");
}
