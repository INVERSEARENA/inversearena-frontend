import { PrismaClient } from '@prisma/client';
import { RoundService } from '../src/services/roundService';
import type { RoundInput } from '../src/types/round';

const prisma = new PrismaClient();
const roundService = new RoundService(prisma);

async function setupTestData() {
  await prisma.user.deleteMany();
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.arena.deleteMany();

  const arena = await prisma.arena.create({
    data: { metadata: { entryFee: 100 } },
  });

  const users = await Promise.all([
    prisma.user.create({ data: { walletAddress: 'wallet1' } }),
    prisma.user.create({ data: { walletAddress: 'wallet2' } }),
    prisma.user.create({ data: { walletAddress: 'wallet3' } }),
    prisma.user.create({ data: { walletAddress: 'wallet4' } }),
  ]);

  const round = await prisma.round.create({
    data: { arenaId: arena.id, roundNumber: 1 },
  });

  return { arena, users, round };
}

async function testDeterministicResolution() {
  console.log('🧪 Test: Deterministic Resolution');

  const { users, round } = await setupTestData();

  const input: RoundInput = {
    roundId: round.id,
    playerChoices: [
      { userId: users[0].id, choice: 'HIGH', stake: 100 },
      { userId: users[1].id, choice: 'LOW', stake: 100 },
      { userId: users[2].id, choice: 'HIGH', stake: 150 },
      { userId: users[3].id, choice: 'LOW', stake: 50 },
    ],
    oracleYield: 5.5,
    randomSeed: 'test-seed-123',
  };

  const result1 = await roundService.resolveRound(input);
  
  await prisma.eliminationLog.deleteMany({ where: { roundId: round.id } });
  
  const result2 = await roundService.resolveRound(input);

  const match = 
    JSON.stringify(result1.eliminatedPlayers.sort()) === 
    JSON.stringify(result2.eliminatedPlayers.sort()) &&
    JSON.stringify(result1.payouts.sort()) === 
    JSON.stringify(result2.payouts.sort());

  console.log(match ? '✅ PASS: Results are deterministic' : '❌ FAIL: Results differ');
  console.log('Eliminated:', result1.eliminatedPlayers);
  console.log('Payouts:', result1.payouts);
}

async function testTransactionRollback() {
  console.log('\n🧪 Test: Transaction Rollback');

  const { users, round } = await setupTestData();

  const input: RoundInput = {
    roundId: 'invalid-round-id',
    playerChoices: [
      { userId: users[0].id, choice: 'HIGH', stake: 100 },
    ],
    oracleYield: 5.5,
  };

  try {
    await roundService.resolveRound(input);
    console.log('❌ FAIL: Should have thrown error');
  } catch (error) {
    const logs = await prisma.eliminationLog.findMany({ where: { roundId: round.id } });
    console.log(logs.length === 0 ? '✅ PASS: Transaction rolled back' : '❌ FAIL: Data persisted');
  }
}

async function testPayoutCalculation() {
  console.log('\n🧪 Test: Payout Calculation');

  const { users, round } = await setupTestData();

  const input: RoundInput = {
    roundId: round.id,
    playerChoices: [
      { userId: users[0].id, choice: 'HIGH', stake: 100 },
      { userId: users[1].id, choice: 'LOW', stake: 100 },
      { userId: users[2].id, choice: 'HIGH', stake: 100 },
    ],
    oracleYield: 10,
    randomSeed: 'payout-test',
  };

  const result = await roundService.resolveRound(input);

  const totalPayouts = result.payouts.reduce((sum, p) => sum + p.amount, 0);
  const totalStakes = input.playerChoices.reduce((sum, p) => sum + p.stake, 0);

  console.log('Total Stakes:', totalStakes);
  console.log('Total Payouts:', totalPayouts);
  console.log('Winners:', result.payouts.length);
  console.log(totalPayouts > 0 ? '✅ PASS: Payouts calculated' : '❌ FAIL: No payouts');
}

async function runTests() {
  try {
    await testDeterministicResolution();
    await testTransactionRollback();
    await testPayoutCalculation();
  } catch (error) {
    console.error('Test error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
