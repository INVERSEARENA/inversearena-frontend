import "dotenv/config";
import { redis } from "../src/cache/redisClient";
import { prisma } from "../src/db/prisma";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    process.env.MONGO_URI = mongoUri;
    // Use test databases or connect to localhost for testing
    process.env.JWT_SECRET = "super-secret-test-key-must-be-at-least-32-chars";
    process.env.NONCE_TTL_SECONDS = "300";
    process.env.ADMIN_API_KEY = "test-admin-key";

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
