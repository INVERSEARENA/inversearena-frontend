import "dotenv/config";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
process.env.JWT_SECRET = "super-secret-test-key-must-be-at-least-32-chars";
process.env.NONCE_TTL_SECONDS = "300";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.MONGOMS_MD5_CHECK = "0";

import { redis } from "../src/cache/redisClient";
import { prisma } from "../src/db/prisma";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
    jest.setTimeout(180_000);
    const mongoCacheDir = join(homedir(), ".cache", "mongodb-binaries");
    // Clean possibly corrupted partial downloads before mongodb-memory-server boots.
    await Promise.all([
        rm(join(mongoCacheDir, "mongodb-macos-arm64-8.2.1.tgz.downloading"), { force: true }),
        rm(join(mongoCacheDir, "mongodb-macos-arm64-8.2.1.tgz"), { force: true }),
        rm(join(mongoCacheDir, "8.2.1.lock"), { force: true }),
    ]);
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    process.env.MONGO_URI = mongoUri;

    // Connect to postgres
    // Ensure the DATABASE_URL is set in the environment or actions

    // Connect to mongoose if required (check start scripts or env vars)
    if (process.env.MONGO_URI) {
        await mongoose.connect(process.env.MONGO_URI);
    }
});

afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
    if (mongoServer) {
        await mongoServer.stop();
    }
});
