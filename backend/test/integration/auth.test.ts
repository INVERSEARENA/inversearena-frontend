import request from "supertest";
import { setupTestApp } from "./testApp";
import { Keypair } from "@stellar/stellar-sdk";
import { NonceModel } from "../../src/db/models/nonce.model";

describe("Auth Flow Integration", () => {
    let app: any;
    const keypair = Keypair.random();

    beforeAll(() => {
        app = setupTestApp();
    });

    it("should request nonce, sign it, and verify to get tokens", async () => {
        // 1. Request Nonce
        const nonceRes = await request(app)
            .post("/api/auth/nonce")
            .send({ walletAddress: keypair.publicKey() });

        expect(nonceRes.status).toBe(201);
        expect(nonceRes.body.nonce).toBeDefined();

        // 2. Sign Nonce
        const signatureBuffer = keypair.sign(Buffer.from(nonceRes.body.nonce, "utf-8"));
        const signature = signatureBuffer.toString("base64");

        // 3. Verify
        const verifyRes = await request(app)
            .post("/api/auth/verify")
            .send({
                walletAddress: keypair.publicKey(),
                signature,
            });

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body.accessToken).toBeDefined();
        expect(verifyRes.body.refreshToken).toBeDefined();
        expect(verifyRes.body.user).toBeDefined();
        expect(verifyRes.body.user.walletAddress).toBe(keypair.publicKey());
    });

    it("returns 401 when nonce has expired", async () => {
        // Request a nonce
        const nonceRes = await request(app)
            .post("/api/auth/nonce")
            .send({ walletAddress: keypair.publicKey() });
        expect(nonceRes.status).toBe(201);
        const { nonce } = nonceRes.body;

        // Manually expire the nonce in the DB
        await NonceModel.updateMany(
            { walletAddress: keypair.publicKey(), used: false },
            { $set: { expiresAt: new Date(Date.now() - 1000) } }
        );

        // Sign the expired nonce
        const signatureBuffer = keypair.sign(Buffer.from(nonce, "utf-8"));
        const signature = signatureBuffer.toString("base64");

        const verifyRes = await request(app)
            .post("/api/auth/verify")
            .send({ walletAddress: keypair.publicKey(), signature });

        expect(verifyRes.status).toBe(401);
        expect(verifyRes.body.error).toMatch(/nonce/i);
    });

    it("returns 401 when nonce has already been used", async () => {
        // Request a fresh nonce
        const nonceRes = await request(app)
            .post("/api/auth/nonce")
            .send({ walletAddress: keypair.publicKey() });
        expect(nonceRes.status).toBe(201);
        const { nonce } = nonceRes.body;

        // Sign and verify (consumes the nonce)
        const signatureBuffer = keypair.sign(Buffer.from(nonce, "utf-8"));
        const signature = signatureBuffer.toString("base64");

        const firstVerify = await request(app)
            .post("/api/auth/verify")
            .send({ walletAddress: keypair.publicKey(), signature });
        expect(firstVerify.status).toBe(200);

        // Try to reuse the same nonce and signature
        const secondVerify = await request(app)
            .post("/api/auth/verify")
            .send({ walletAddress: keypair.publicKey(), signature });

        expect(secondVerify.status).toBe(401);
        expect(secondVerify.body.error).toMatch(/nonce/i);
    });
});
