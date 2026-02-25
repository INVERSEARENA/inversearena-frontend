import request from "supertest";
import { setupTestApp } from "./testApp";
import { Keypair } from "@stellar/stellar-sdk";

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
});
