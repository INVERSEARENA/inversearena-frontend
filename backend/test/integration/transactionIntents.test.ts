import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { setupTestApp } from "./testApp";

const VALID_XDR = "AAAAAgAAAAA".padEnd(40, "A");

describe("Transaction Intents Integration (#1381)", () => {
    let app: any;
    const wallet = Keypair.random().publicKey();

    beforeAll(() => {
        app = setupTestApp();
    });

    it("creates an intent, then walks it through the full sign -> submit -> confirm lifecycle", async () => {
        const createRes = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey: `lifecycle-${wallet}-1`,
            kind: "stake",
            unsignedXdr: VALID_XDR,
        });
        expect(createRes.status).toBe(201);
        expect(createRes.body.mode).toBe("created");
        expect(createRes.body.intent.status).toBe("built");
        const intentId = createRes.body.intent.id;

        const signingRes = await request(app)
            .post(`/api/transaction-intents/${intentId}/awaiting-signature`)
            .send({ ownerWallet: wallet });
        expect(signingRes.status).toBe(200);
        expect(signingRes.body.status).toBe("awaiting_signature");

        const signedRes = await request(app)
            .post(`/api/transaction-intents/${intentId}/signed`)
            .send({ ownerWallet: wallet, signedXdr: VALID_XDR });
        expect(signedRes.status).toBe(200);
        expect(signedRes.body.status).toBe("submitted");

        const outcomeRes = await request(app)
            .post(`/api/transaction-intents/${intentId}/outcome`)
            .send({ ownerWallet: wallet, status: "confirmed", txHash: "deadbeef" });
        expect(outcomeRes.status).toBe(200);
        expect(outcomeRes.body.status).toBe("confirmed");
        expect(outcomeRes.body.txHash).toBe("deadbeef");

        const getRes = await request(app)
            .get(`/api/transaction-intents/${intentId}`)
            .query({ ownerWallet: wallet });
        expect(getRes.status).toBe(200);
        expect(getRes.body.status).toBe("confirmed");
    });

    it("resumes the same intent record across a wallet rejection instead of creating a second one (#1381 core criterion)", async () => {
        const idempotencyKey = `resume-${wallet}-1`;

        const createRes = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey,
            kind: "join_arena",
            unsignedXdr: VALID_XDR,
        });
        const intentId = createRes.body.intent.id;

        await request(app)
            .post(`/api/transaction-intents/${intentId}/awaiting-signature`)
            .send({ ownerWallet: wallet });

        // Wallet rejects the signature request.
        const rejectRes = await request(app)
            .post(`/api/transaction-intents/${intentId}/signature-failure`)
            .send({ ownerWallet: wallet, reason: "rejected" });
        expect(rejectRes.status).toBe(200);
        expect(rejectRes.body.status).toBe("built");

        // Client "Try Again": re-creating with the SAME idempotency key must
        // resume the same record (same original unsigned XDR), not mint a
        // second, untracked one.
        const resumeRes = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey,
            kind: "join_arena",
            unsignedXdr: VALID_XDR,
        });
        expect(resumeRes.status).toBe(200);
        expect(resumeRes.body.mode).toBe("resumed");
        expect(resumeRes.body.intent.id).toBe(intentId);

        // Retrying signing against the resumed record bumps signAttempts
        // rather than resetting state.
        const retrySigningRes = await request(app)
            .post(`/api/transaction-intents/${intentId}/awaiting-signature`)
            .send({ ownerWallet: wallet });
        expect(retrySigningRes.status).toBe(200);
        expect(retrySigningRes.body.signAttempts).toBe(2);
        expect(retrySigningRes.body.unsignedXdr).toBe(VALID_XDR);
    });

    it("one wallet cannot read another wallet's intent (ownership boundary)", async () => {
        const createRes = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey: `owner-${wallet}-1`,
            kind: "claim",
            unsignedXdr: VALID_XDR,
        });
        const intentId = createRes.body.intent.id;

        const otherWallet = Keypair.random().publicKey();
        const res = await request(app)
            .get(`/api/transaction-intents/${intentId}`)
            .query({ ownerWallet: otherWallet });

        // Indistinguishable from "does not exist" — never a distinct status
        // that would confirm the id belongs to someone else.
        expect(res.status).toBe(404);
    });

    it("rejects invalid-input bodies (boundary/invalid-input path)", async () => {
        const tooShortXdr = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey: `invalid-${wallet}-1`,
            kind: "stake",
            unsignedXdr: "short",
        });
        expect(tooShortXdr.status).toBe(400);

        const badKind = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey: `invalid-${wallet}-2`,
            kind: "not_a_real_kind",
            unsignedXdr: VALID_XDR,
        });
        expect(badKind.status).toBe(400);

        const missingOwnerWallet = await request(app).post("/api/transaction-intents").send({
            idempotencyKey: `invalid-${wallet}-3`,
            kind: "stake",
            unsignedXdr: VALID_XDR,
        });
        expect(missingOwnerWallet.status).toBe(400);

        const nonUuidId = await request(app)
            .get("/api/transaction-intents/not-a-uuid")
            .query({ ownerWallet: wallet });
        expect(nonUuidId.status).toBe(400);
    });

    it("rejects an out-of-order transition (attaching a signature before awaiting-signature)", async () => {
        const createRes = await request(app).post("/api/transaction-intents").send({
            ownerWallet: wallet,
            idempotencyKey: `out-of-order-${wallet}-1`,
            kind: "commit_choice",
            unsignedXdr: VALID_XDR,
        });
        const intentId = createRes.body.intent.id;

        const res = await request(app)
            .post(`/api/transaction-intents/${intentId}/signed`)
            .send({ ownerWallet: wallet, signedXdr: VALID_XDR });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("INTENT_INVALID_STATE");
    });
});
