# Issue #1593: Consolidate Mongo and Prisma Persistence into Single Postgres Store

## Problem

Backend uses both:
- **Prisma/Postgres**: User, Arena, Pool, Round, Transaction, EliminationLog
- **Mongoose/MongoDB**: transactions, nonces, refresh tokens, confirmation tokens, audit logs, payout nonce counters

**Limitations:**
- Two databases with overlapping concepts
- Two connection pools, two migration systems
- No cross-store transactions
- Identity joins across stores
- Operating, backing up, testing requires both databases

## Solution

Migrate all Mongoose models to Prisma/Postgres with proper constraints, indexes, and scheduled cleanup jobs to replace MongoDB TTL indexes.

## Prisma Schema Additions

```prisma
// Nonce tracking (was Mongoose)
model Nonce {
  id          String   @id @default(uuid())
  address     String   // Wallet address
  nonce       String   @unique
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime @default(now())

  @@index([address, expiresAt])
  @@index([expiresAt]) // For cleanup job
}

// Refresh token with family tracking (was Mongoose)
model RefreshToken {
  id           String   @id @default(uuid())
  userId       String
  token        String   @unique
  familyId     String   // Token family for reuse detection
  expiresAt    DateTime
  revokedAt    DateTime?
  lastUsedAt   DateTime?
  createdAt    DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, familyId])
  @@index([expiresAt]) // For cleanup job
}

// Email confirmation tokens (was Mongoose)
model ConfirmationToken {
  id          String   @id @default(uuid())
  email       String
  token       String   @unique
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime @default(now())

  @@index([email])
  @@index([expiresAt]) // For cleanup job
}

// Audit log (was Mongoose)
model AuditLog {
  id          String   @id @default(uuid())
  userId      String?
  action      String   // e.g., "user.login", "arena.create"
  resource    String?  // Resource ID if applicable
  metadata    Json?    // Additional context
  ipAddress   String?
  userAgent   String?
  createdAt   DateTime @default(now())

  @@index([userId, createdAt])
  @@index([action, createdAt])
  @@index([createdAt]) // For retention cleanup
}

// Payout nonce counter (was Mongoose atomic counter)
model PayoutNonce {
  id        String   @id @default(uuid())
  arenaId   String   @unique
  counter   Int      @default(0)
  updatedAt DateTime @updatedAt

  @@index([arenaId])
}
```

## Atomic Counter Implementation

```typescript
// backend/src/repositories/payoutNonceRepository.ts

export class PayoutNonceRepository {
  /**
   * Atomically increment and return next nonce.
   * Uses UPDATE ... RETURNING for atomic operation.
   */
  async getNextNonce(arenaId: string): Promise<number> {
    // Use raw SQL for atomic increment
    const result = await prisma.$queryRaw`
      UPDATE "PayoutNonce"
      SET counter = counter + 1, "updatedAt" = NOW()
      WHERE "arenaId" = ${arenaId}
      RETURNING counter
    `;

    if (result.length === 0) {
      // Initialize if doesn't exist
      const created = await prisma.payoutNonce.create({
        data: { arenaId, counter: 1 },
      });
      return created.counter;
    }

    return result[0].counter;
  }
}
```

## Scheduled Cleanup Jobs

```typescript
// backend/src/jobs/cleanupExpiredTokens.ts

import { CronJob } from 'cron';
import { PrismaClient } from '@prisma/client';

/**
 * Replaces MongoDB TTL indexes with scheduled cleanup.
 * Runs daily at 2 AM to remove expired records.
 */
export function startCleanupJobs(prisma: PrismaClient) {
  // Clean expired nonces (daily at 2 AM)
  new CronJob('0 2 * * *', async () => {
    const deleted = await prisma.nonce.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    console.log(`Cleaned up ${deleted.count} expired nonces`);
  }).start();

  // Clean expired refresh tokens
  new CronJob('0 2 * * *', async () => {
    const deleted = await prisma.refreshToken.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    console.log(`Cleaned up ${deleted.count} expired refresh tokens`);
  }).start();

  // Clean expired confirmation tokens
  new CronJob('0 2 * * *', async () => {
    const deleted = await prisma.confirmationToken.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    console.log(`Cleaned up ${deleted.count} expired confirmation tokens`);
  }).start();

  // Archive old audit logs (retain 90 days)
  new CronJob('0 3 * * *', async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const deleted = await prisma.auditLog.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });
    console.log(`Archived ${deleted.count} old audit logs`);
  }).start();
}
```

## Data Migration Script

```typescript
// backend/src/scripts/migrateMongoToPostgres.ts

import { MongoClient } from 'mongodb';
import { PrismaClient } from '@prisma/client';

async function migrate(dryRun: boolean = true) {
  const mongo = new MongoClient(process.env.MONGODB_URL!);
  const prisma = new PrismaClient();

  await mongo.connect();
  const db = mongo.db('inversearena');

  // Migrate nonces
  const nonces = await db.collection('nonces').find().toArray();
  console.log(`Found ${nonces.length} nonces to migrate`);

  for (const nonce of nonces) {
    if (!dryRun) {
      await prisma.nonce.upsert({
        where: { nonce: nonce.nonce },
        create: {
          address: nonce.address,
          nonce: nonce.nonce,
          expiresAt: nonce.expiresAt,
          consumedAt: nonce.consumedAt || null,
          createdAt: nonce.createdAt,
        },
        update: {},
      });
    }
  }

  // Migrate refresh tokens
  const tokens = await db.collection('refresh_tokens').find().toArray();
  console.log(`Found ${tokens.length} refresh tokens to migrate`);

  for (const token of tokens) {
    if (!dryRun) {
      await prisma.refreshToken.upsert({
        where: { token: token.token },
        create: {
          userId: token.userId,
          token: token.token,
          familyId: token.familyId || token.token,
          expiresAt: token.expiresAt,
          revokedAt: token.revokedAt || null,
          createdAt: token.createdAt,
        },
        update: {},
      });
    }
  }

  // Verification counts
  if (!dryRun) {
    const postgresNonces = await prisma.nonce.count();
    const postgresTokens = await prisma.refreshToken.count();

    console.log('\\nMigration verification:');
    console.log(`  Mongo nonces: ${nonces.length}`);
    console.log(`  Postgres nonces: ${postgresNonces}`);
    console.log(`  Mongo tokens: ${tokens.length}`);
    console.log(`  Postgres tokens: ${postgresTokens}`);

    if (postgresNonces !== nonces.length || postgresTokens !== tokens.length) {
      throw new Error('Migration count mismatch!');
    }
  }

  console.log(`\\nMigration ${dryRun ? '(DRY RUN)' : ''} complete`);
  await mongo.close();
}

// Run with: npx tsx src/scripts/migrateMongoToPostgres.ts [--apply]
const dryRun = !process.argv.includes('--apply');
migrate(dryRun);
```

## Repository Updates

Update all repositories from Mongoose to Prisma:

```typescript
// Before (Mongoose)
const nonce = await NonceModel.findOneAndUpdate(
  { address, consumed: false },
  { consumed: true },
  { new: true }
);

// After (Prisma)
const nonce = await prisma.nonce.updateMany({
  where: {
    address,
    consumedAt: null,
  },
  data: {
    consumedAt: new Date(),
  },
});
```

## Remove MongoDB Dependencies

```bash
# Remove from package.json
npm uninstall mongoose mongodb

# Remove from docker-compose.yml
# Delete mongodb service

# Remove from CI
# Delete mongodb setup in .github/workflows/backend-ci.yml
```

## Acceptance Criteria

- [ ] Prisma models for all Mongoose collections
- [ ] Unique constraints and indexes match MongoDB
- [ ] Scheduled cleanup jobs replace TTL indexes
- [ ] Atomic counters use row locking/UPDATE RETURNING
- [ ] Migration script with dry-run and verification
- [ ] mongoose dependency removed
- [ ] docker-compose.yml updated
- [ ] CI updated (single database)
- [ ] All tests pass against Postgres only
- [ ] Documentation updated

## Testing

```typescript
describe('Nonce consumption', () => {
  it('prevents double consumption under concurrency', async () => {
    const address = 'GTEST...';
    const nonce = await nonceRepo.create(address);

    // Concurrent consumption attempts
    const results = await Promise.allSettled([
      nonceRepo.consume(nonce),
      nonceRepo.consume(nonce),
      nonceRepo.consume(nonce),
    ]);

    // Only one should succeed
    const succeeded = results.filter(r => r.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
  });
});

describe('Refresh token reuse detection', () => {
  it('revokes family on reuse attempt', async () => {
    const token1 = await tokenRepo.create(userId, familyId);
    const token2 = await tokenRepo.rotate(token1); // Valid rotation

    // Try to reuse token1 (should revoke family)
    await expect(tokenRepo.verify(token1)).rejects.toThrow();

    // token2 should also be revoked
    await expect(tokenRepo.verify(token2)).rejects.toThrow();
  });
});
```

## Migration Steps

1. Add Prisma models (non-breaking)
2. Deploy migration script (read-only dry-run)
3. Verify counts match
4. Run migration with --apply
5. Update repositories to use Prisma
6. Keep MongoDB running (read-only fallback)
7. Monitor for 1 week
8. Remove MongoDB from docker-compose and CI
9. Remove mongoose dependency

## Benefits

- Single database to operate, backup, test
- Cross-store transactions possible
- Simpler deployment (one connection pool)
- Type-safe queries with Prisma
- Better performance (no cross-database joins)
