import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Start seeding...');

    // Create Users
    const user1 = await prisma.user.upsert({
        where: { walletAddress: 'GCXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
        update: {},
        create: {
            walletAddress: 'GCXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        },
    });

    const user2 = await prisma.user.upsert({
        where: { walletAddress: 'GDOXYZ0987654321ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
        update: {},
        create: {
            walletAddress: 'GDOXYZ0987654321ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        },
    });

    console.log(`Created users: ${user1.walletAddress}, ${user2.walletAddress}`);

    // Create Arenas
    const arena1 = await prisma.arena.create({
        data: {
            metadata: { name: 'Beginner Arena', minStake: 10, maxStake: 100 },
            pools: {
                create: [
                    { stakeAmount: 10.5 },
                    { stakeAmount: 50.0 },
                ],
            },
        },
    });

    const arena2 = await prisma.arena.create({
        data: {
            metadata: { name: 'Pro Arena', minStake: 100, maxStake: 1000 },
            pools: {
                create: [
                    { stakeAmount: 100 },
                    { stakeAmount: 500 },
                ],
            },
        },
    });

    console.log(`Created arenas: ${arena1.id}, ${arena2.id}`);

    // Create Rounds and Elimination Logs
    const round1 = await prisma.round.create({
        data: {
            arenaId: arena1.id,
            roundNumber: 1,
            eliminationLogs: {
                create: [
                    {
                        userId: user1.id,
                        reason: 'Failed to predict outcome',
                    },
                ],
            },
        },
    });

    console.log(`Created round ${round1.roundNumber} for arena ${arena1.id}`);

    // Create Transactions
    const tx1 = await prisma.transaction.create({
        data: {
            txHash: '0xabc123def4567890abcdef1234567890abcdef12',
            userId: user1.id,
            amount: 100.5,
            type: 'DEPOSIT',
            status: 'SUCCESS',
        },
    });

    console.log(`Created transaction ${tx1.txHash}`);

    console.log('Seeding finished.');
}

main()
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (e) => {
        console.error(e);
        await prisma.$disconnect();
        process.exit(1);
    });
