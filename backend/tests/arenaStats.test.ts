import { PrismaClient } from '@prisma/client';
import { ArenaStatsService } from '../src/services/arenaStatsService';

const prisma = new PrismaClient();
const statsService = new ArenaStatsService(prisma);

async function setupTestData() {
  // Clean up
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();

  // Create arena
  const arena = await prisma.arena.create({
    data: { 
      metadata: { minStake: 50 } 
    },
  });

  // Create users
  const users = await Promise.all([
    prisma.user.create({ data: { walletAddress: 'user1' } }),
    prisma.user.create({ data: { walletAddress: 'user2' } }),
    prisma.user.create({ data: { walletAddress: 'user3' } }),
  ]);

  // Create first round with choices
  const round1 = await prisma.round.create({
    data: {
      arenaId: arena.id,
      roundNumber: 1,
      state: 'RESOLVED',
      metadata: {
        playerChoices: [
          { userId: users[0].id, stake: 50 },
          { userId: users[1].id, stake: 50 },
          { userId: users[2].id, stake: 50 },
        ],
        oracleYield: 10,
      }
    }
  });

  // Eliminate one user in round 1
  await prisma.eliminationLog.create({
    data: {
      roundId: round1.id,
      userId: users[2].id,
      reason: 'Wrong choice'
    }
  });

  // Create second round
  const round2 = await prisma.round.create({
    data: {
      arenaId: arena.id,
      roundNumber: 2,
      state: 'OPEN',
      metadata: {
        playerChoices: [
          { userId: users[0].id, stake: 60 },
          { userId: users[1].id, stake: 60 },
        ]
      }
    }
  });

  return { arena, users, round1, round2 };
}

async function testGetStats() {
  console.log('🧪 Test: Get Arena Stats');
  
  const { arena } = await setupTestData();
  
  const stats = await statsService.getArenaStats(arena.id);
  
  console.log('Stats:', JSON.stringify(stats, null, 2));

  const assertions = [
    stats.arenaId === arena.id,
    stats.playerCount === 3,
    stats.survivorCount === 2,
    stats.currentPot === 120, // 60 + 60 from round 2
    stats.currentRound === 2,
    stats.entryFee === 50,
    stats.yieldAccrued === 10,
    stats.status === 'open'
  ];

  if (assertions.every(a => a)) {
    console.log('✅ PASS: Stats are correct');
  } else {
    throw new Error('❌ FAIL: Some stats are incorrect');
  }
}

async function testArenaNotFound() {
  console.log('\n🧪 Test: Arena Not Found');
  
  try {
    await statsService.getArenaStats('non-existent-id');
    throw new Error('❌ FAIL: Should have thrown error');
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      console.log('✅ PASS: Correctly threw not found error');
    } else {
      throw new Error(`❌ FAIL: Threw unexpected error: ${error}`);
    }
  }
}

async function runTests() {
  try {
    await testGetStats();
    await testArenaNotFound();
  } catch (error) {
    console.error('Test suite failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
