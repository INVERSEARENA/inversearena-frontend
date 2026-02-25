import { prisma } from "../../src/db/prisma";

describe("Pool Creation Integration", () => {
    it("should create an arena and a pool in the database", async () => {
        // 1. Create Arena
        const arena = await prisma.arena.create({
            data: {
                metadata: { name: "Test Arena", fee: 10 },
            },
        });

        expect(arena).toBeDefined();
        expect(arena.id).toBeDefined();

        // 2. Create Pool
        const pool = await prisma.pool.create({
            data: {
                arenaId: arena.id,
                stakeAmount: 100,
            },
        });

        expect(pool).toBeDefined();
        expect(pool.id).toBeDefined();
        expect(pool.arenaId).toBe(arena.id);
        expect(pool.stakeAmount).toBe(100);

        // Clean up
        await prisma.pool.delete({ where: { id: pool.id } });
        await prisma.arena.delete({ where: { id: arena.id } });
    });
});
