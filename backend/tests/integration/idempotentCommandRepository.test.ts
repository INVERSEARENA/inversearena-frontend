/**
 * Real-Postgres integration coverage for #1386's concurrency guarantees.
 *
 * The unit tests in test/roundServiceIdempotency.unit.test.ts exercise
 * RoundService's orchestration logic against an in-memory fake repository.
 * This file instead proves the two claims that fake CANNOT prove on its
 * own — that the actual database constraints make the race conditions
 * impossible, not just the application code's happy-path logic:
 *  - tryClaim's uniqueness guarantee under a real concurrent race (the
 *    unique index on idempotency_key, not application-level locking).
 *  - reclaimForRetry's conditional UPDATE genuinely admits only one winner
 *    when two callers race to retry the same failed/stale row.
 *
 * Requires a real DATABASE_URL (this repo has no bootstrapped Postgres
 * test fixture the way MongoMemoryServer covers Mongo — see test/setup.ts).
 * Skips automatically when one isn't configured, matching
 * test/integration/resolveRound.test.ts's existing skip precedent.
 */
import { PrismaClient } from '@prisma/client';
import { IdempotentCommandRepository } from '../../src/repositories/idempotentCommandRepository';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb('IdempotentCommandRepository (real Postgres)', () => {
  let prisma: PrismaClient;
  let repo: IdempotentCommandRepository;

  beforeAll(() => {
    prisma = new PrismaClient();
    repo = new IdempotentCommandRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.idempotentCommand.deleteMany({});
  });

  it('normal path: tryClaim succeeds for a brand-new key', async () => {
    const claimed = await repo.tryClaim('key-1', 'resolve_round', 'round-1');
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('in_progress');
  });

  it('duplicate delivery: a second tryClaim for the same key returns null, not a second row', async () => {
    await repo.tryClaim('key-2', 'resolve_round', 'round-1');
    const second = await repo.tryClaim('key-2', 'resolve_round', 'round-1');

    expect(second).toBeNull();
    const rows = await prisma.idempotentCommand.findMany({ where: { idempotencyKey: 'key-2' } });
    expect(rows).toHaveLength(1);
  });

  it('concurrent requests: exactly one of two racing tryClaim calls for the same key wins', async () => {
    const [a, b] = await Promise.all([
      repo.tryClaim('key-race-1', 'resolve_round', 'round-1'),
      repo.tryClaim('key-race-1', 'resolve_round', 'round-1'),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it('markCompleted stores the durable result, and findByKey returns it verbatim', async () => {
    await repo.tryClaim('key-3', 'close_round', 'round-1');
    await repo.markCompleted('key-3', { state: 'CLOSED' });

    const found = await repo.findByKey('key-3');
    expect(found?.status).toBe('completed');
    expect(found?.result).toEqual({ state: 'CLOSED' });
  });

  it('markFailed records the error and leaves the row reclaimable', async () => {
    await repo.tryClaim('key-4', 'resolve_round', 'round-1');
    await repo.markFailed('key-4', 'rpc timeout');

    const found = await repo.findByKey('key-4');
    expect(found?.status).toBe('failed');
    expect(found?.errorMessage).toBe('rpc timeout');
  });

  it('reclaimForRetry(failed) succeeds once and flips the row back to in_progress', async () => {
    await repo.tryClaim('key-5', 'resolve_round', 'round-1');
    await repo.markFailed('key-5', 'boom');

    const reclaimed = await repo.reclaimForRetry('key-5', 'failed', 0);
    expect(reclaimed).toBe(true);

    const found = await repo.findByKey('key-5');
    expect(found?.status).toBe('in_progress');
  });

  it('concurrent requests: exactly one of two racing reclaimForRetry(failed) calls wins', async () => {
    await repo.tryClaim('key-race-2', 'resolve_round', 'round-1');
    await repo.markFailed('key-race-2', 'boom');

    const [a, b] = await Promise.all([
      repo.reclaimForRetry('key-race-2', 'failed', 0),
      repo.reclaimForRetry('key-race-2', 'failed', 0),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('reclaimForRetry(in_progress) refuses a claim younger than staleAfterMs', async () => {
    await repo.tryClaim('key-6', 'resolve_round', 'round-1');

    const reclaimed = await repo.reclaimForRetry('key-6', 'in_progress', 10 * 60 * 1000);
    expect(reclaimed).toBe(false);

    const found = await repo.findByKey('key-6');
    expect(found?.status).toBe('in_progress');
  });

  it('boundary: reclaimForRetry(in_progress) succeeds once staleAfterMs has genuinely elapsed', async () => {
    await repo.tryClaim('key-7', 'resolve_round', 'round-1');

    // updatedAt is set by the create() call microseconds earlier — a
    // staleAfterMs of 0 can land in the same millisecond as Date.now(),
    // which fails the strict `updatedAt < now` comparison at the DB level
    // (not a real-world case: an actually-stale claim is always minutes
    // old). A short real wait makes elapsed time unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reclaimed = await repo.reclaimForRetry('key-7', 'in_progress', 10);
    expect(reclaimed).toBe(true);
  });

  it('invalid-input path: reclaimForRetry(failed) is a no-op against a row that is not failed', async () => {
    await repo.tryClaim('key-8', 'resolve_round', 'round-1');
    // Still in_progress, never marked failed.

    const reclaimed = await repo.reclaimForRetry('key-8', 'failed', 0);
    expect(reclaimed).toBe(false);
  });
});
