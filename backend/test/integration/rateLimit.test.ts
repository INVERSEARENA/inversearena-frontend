import request from "supertest";
import { setupTestApp } from "./testApp";
import { Keypair } from "@stellar/stellar-sdk";
import { clearLimiterCache } from "../../src/middleware/rateLimit";

// Use a valid Stellar keypair so the nonce endpoint accepts the address.
const TEST_KEYPAIR = Keypair.random();
const TEST_WALLET = TEST_KEYPAIR.publicKey();

// Isolated IPs — each describe block uses its own to avoid cross-test pollution.
const NONCE_IP = "10.1.0.1";
const POOLS_IP = "10.1.0.2";

describe("Rate limiting on POST /api/auth/nonce", () => {
    let app: ReturnType<typeof setupTestApp>;

    beforeAll(() => {
        // Override the nonce limit to a small value so tests run quickly.
        process.env.RATE_LIMIT_NONCE_POINTS = "3";
        process.env.RATE_LIMIT_NONCE_WINDOW_SECONDS = "60";
        process.env.RATE_LIMIT_NONCE_PREFIX = "rl:test:nonce:ci";
        clearLimiterCache();
        app = setupTestApp();
    });

    afterAll(() => {
        clearLimiterCache();
        delete process.env.RATE_LIMIT_NONCE_POINTS;
        delete process.env.RATE_LIMIT_NONCE_WINDOW_SECONDS;
        delete process.env.RATE_LIMIT_NONCE_PREFIX;
    });

    it("allows requests up to the configured limit", async () => {
        const limit = parseInt(process.env.RATE_LIMIT_NONCE_POINTS ?? "3", 10);

        for (let i = 0; i < limit; i++) {
            const res = await request(app)
                .post("/api/auth/nonce")
                .set("X-Forwarded-For", NONCE_IP)
                .send({ walletAddress: TEST_WALLET });

            expect(res.status).not.toBe(429);
        }
    });

    it("returns 429 with Retry-After on the request after the limit is exceeded", async () => {
        // The previous test exhausted the limit; this request is one over.
        const res = await request(app)
            .post("/api/auth/nonce")
            .set("X-Forwarded-For", NONCE_IP)
            .send({ walletAddress: TEST_WALLET });

        expect(res.status).toBe(429);
        expect(res.headers["retry-after"]).toBeDefined();
        const retryAfter = Number(res.headers["retry-after"]);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
    });

    it("scopes the limit by IP + wallet address independently", async () => {
        // A different wallet on the same IP gets its own bucket.
        const otherWallet = Keypair.random().publicKey();
        const res = await request(app)
            .post("/api/auth/nonce")
            .set("X-Forwarded-For", NONCE_IP)
            .send({ walletAddress: otherWallet });

        expect(res.status).not.toBe(429);
    });

    it("a different IP is not affected by the exhausted limit", async () => {
        const res = await request(app)
            .post("/api/auth/nonce")
            .set("X-Forwarded-For", "10.1.0.99")
            .send({ walletAddress: TEST_WALLET });

        expect(res.status).not.toBe(429);
    });
});

describe("Rate limiting on POST /api/pools", () => {
    let app: ReturnType<typeof setupTestApp>;

    beforeAll(() => {
        process.env.RATE_LIMIT_POOLS_POINTS = "2";
        process.env.RATE_LIMIT_POOLS_WINDOW_SECONDS = "60";
        process.env.RATE_LIMIT_POOLS_PREFIX = "rl:test:pools:ci";
        clearLimiterCache();
        app = setupTestApp();
    });

    afterAll(() => {
        clearLimiterCache();
        delete process.env.RATE_LIMIT_POOLS_POINTS;
        delete process.env.RATE_LIMIT_POOLS_WINDOW_SECONDS;
        delete process.env.RATE_LIMIT_POOLS_PREFIX;
    });

    it("returns 429 with Retry-After on POST /api/pools after the limit is exceeded", async () => {
        if (!process.env.DATABASE_URL) return;

        const limit = parseInt(process.env.RATE_LIMIT_POOLS_POINTS ?? "2", 10);

        // Obtain a JWT token via the full auth flow.
        const keypair = Keypair.random();
        const walletAddress = keypair.publicKey();

        const nonceRes = await request(app)
            .post("/api/auth/nonce")
            .set("X-Forwarded-For", "10.1.0.98")
            .send({ walletAddress });
        expect(nonceRes.status).toBe(201);

        const signatureBuffer = keypair.sign(Buffer.from(nonceRes.body.nonce, "utf-8"));
        const signature = signatureBuffer.toString("base64");

        const verifyRes = await request(app)
            .post("/api/auth/verify")
            .set("X-Forwarded-For", "10.1.0.98")
            .send({ walletAddress, signature });
        expect(verifyRes.status).toBe(200);

        const { accessToken } = verifyRes.body;

        // Create a real arena so the pool FK constraint is satisfied.
        const { prisma } = await import("../../src/db/prisma");
        const arena = await prisma.arena.create({ data: { metadata: {} } });

        let lastRes: request.Response | undefined;

        for (let i = 0; i <= limit; i++) {
            lastRes = await request(app)
                .post("/api/pools")
                .set("Authorization", `Bearer ${accessToken}`)
                .set("X-Forwarded-For", POOLS_IP)
                .send({ arenaId: arena.id, stakeAmount: 10 });
        }

        // Clean up arenas and pools created during test
        await prisma.pool.deleteMany({ where: { arenaId: arena.id } });
        await prisma.arena.delete({ where: { id: arena.id } });

        expect(lastRes!.status).toBe(429);
        expect(lastRes!.headers["retry-after"]).toBeDefined();
        const retryAfter = Number(lastRes!.headers["retry-after"]);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
    });
});
