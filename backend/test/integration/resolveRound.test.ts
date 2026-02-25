import request from "supertest";
import { setupTestApp } from "./testApp";
import { prisma } from "../../src/db/prisma";

describe("Resolve Round Integration", () => {
    let app: any;
    let adminHeader: string;

    beforeAll(() => {
        app = setupTestApp();
        adminHeader = `Bearer ${process.env.ADMIN_API_KEY}`;
    });

    it("should resolve a round using admin token", async () => {
        // 1. Setup Data
        const user1 = await prisma.user.create({
            data: { walletAddress: "G_TEST_USER_1_" + Date.now() },
        });
        const user2 = await prisma.user.create({
            data: { walletAddress: "G_TEST_USER_2_" + Date.now() },
        });

        const arena = await prisma.arena.create({ data: {} });
        const round = await prisma.round.create({
            data: {
                arenaId: arena.id,
                roundNumber: 1,
                state: "OPEN",
            },
        });

        // 2. Resolve Round via Admin API
        const res = await request(app)
            .post("/api/admin/rounds/resolve")
            .set("Authorization", adminHeader)
            .send({
                roundId: round.id,
                playerChoices: [
                    { userId: user1.id, choice: "UP", stake: 100 },
                    { userId: user2.id, choice: "DOWN", stake: 100 },
                ],
                oracleYield: 5.5,
                randomSeed: "test_seed",
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.payouts).toBeDefined();

        // 3. Verify in DB
        const updatedRound = await prisma.round.findUnique({
            where: { id: round.id },
        });
        expect(updatedRound?.state).toBe("RESOLVED");

        // Clean up
        await prisma.eliminationLog.deleteMany({ where: { roundId: round.id } });
        await prisma.round.delete({ where: { id: round.id } });
        await prisma.arena.delete({ where: { id: arena.id } });
        await prisma.user.deleteMany({ where: { id: { in: [user1.id, user2.id] } } });
    });
});
