# Issue #1592: Replace Backend Float Payout Computation with On-Chain Settlement Amounts

## Problem Statement

The backend currently recomputes winner payouts off-chain using floating-point arithmetic in `src/domain/settlement.ts`:

```typescript
const yieldAmount = eliminatedStake * (oracleYieldPercent / 100);
```

This implementation has several issues:
1. **Treats oracleYield as percentage** while the contract uses basis points
2. **Uses floating-point** for money calculations (precision loss)
3. **Can produce amounts** that differ from actual on-chain settlement
4. **Backend becomes source of truth** instead of the contract

## Solution Overview

The backend must never derive settlement amounts. Instead, it should:
1. Read `prize_claimed` events from the arena contract
2. Extract exact integer settlement amounts (total, yield, fees)
3. Store these amounts as bigint/integers in the database
4. Use these authoritative figures for any payout flows

## Implementation Plan

### 1. Create Settlement Event Reader

**File**: `backend/src/services/settlementReader.ts`

```typescript
import { ContractEventType } from '../types/events';

export interface PrizeClaimedEvent {
  roundId: string;
  winner: string;
  totalPayout: bigint;      // Atomic units (stroops)
  yieldPortion: bigint;     // Atomic units
  platformFee: bigint;      // Atomic units
  timestamp: Date;
}

export class SettlementReader {
  /**
   * Read prize_claimed event for a specific round.
   * Returns null if claim hasn't executed yet.
   */
  async getPrizeClaimedEvent(
    arenaContractId: string,
    roundNumber: number
  ): Promise<PrizeClaimedEvent | null> {
    // Query Soroban RPC for prize_claimed events
    // Filter by round_id
    // Parse XDR event data to extract amounts
    // Return null if no event found (claim pending)
  }

  /**
   * Read settlement state directly from contract storage.
   * Fallback when event not available.
   */
  async getSettlementState(
    arenaContractId: string,
    roundNumber: number
  ): Promise<PrizeClaimedEvent | null> {
    // Call contract's get_settlement view function
    // Map storage values to PrizeClaimedEvent structure
  }

  /**
   * Get authoritative settlement for a round.
   * Tries event first, falls back to state query.
   */
  async getSettlement(
    arenaContractId: string,
    roundNumber: number
  ): Promise<PrizeClaimedEvent | null> {
    const event = await this.getPrizeClaimedEvent(arenaContractId, roundNumber);
    if (event) return event;
    
    return this.getSettlementState(arenaContractId, roundNumber);
  }
}
```

### 2. Update Database Schema

**File**: `backend/prisma/schema.prisma`

```prisma
model Round {
  // ... existing fields

  // Settlement amounts in atomic units (stroops)
  settlementTotal      BigInt?    // Total payout amount
  settlementYield      BigInt?    // Yield portion
  settlementFee        BigInt?    // Platform fee
  settlementTimestamp  DateTime?  // When claim was executed
  settlementTxHash     String?    // Transaction hash of claim
  
  // Flag indicating settlement was read from chain
  settlementVerified   Boolean   @default(false)
}
```

**Migration**: `backend/prisma/migrations/YYYYMMDD_add_settlement_fields.sql`

```sql
-- Add settlement tracking columns
ALTER TABLE "Round" 
  ADD COLUMN "settlementTotal" BIGINT,
  ADD COLUMN "settlementYield" BIGINT,
  ADD COLUMN "settlementFee" BIGINT,
  ADD COLUMN "settlementTimestamp" TIMESTAMP,
  ADD COLUMN "settlementTxHash" TEXT,
  ADD COLUMN "settlementVerified" BOOLEAN DEFAULT false;

-- Index for querying unverified settlements
CREATE INDEX "Round_settlementVerified_idx" 
  ON "Round"("settlementVerified") 
  WHERE "settlementVerified" = false;
```

### 3. Create Money Value Object

**File**: `backend/src/types/money.ts`

```typescript
/**
 * Represents an exact monetary amount in atomic units (stroops for XLM).
 * No floating-point arithmetic allowed.
 */
export class MoneyAmount {
  private readonly atomicValue: bigint;
  private readonly decimals: number;

  private constructor(atomicValue: bigint, decimals: number = 7) {
    if (atomicValue < 0n) {
      throw new Error('Money amount cannot be negative');
    }
    this.atomicValue = atomicValue;
    this.decimals = decimals;
  }

  static fromAtomic(value: bigint, decimals: number = 7): MoneyAmount {
    return new MoneyAmount(value, decimals);
  }

  static fromDecimalString(value: string, decimals: number = 7): MoneyAmount {
    const parts = value.split('.');
    const whole = BigInt(parts[0] || '0');
    const fraction = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
    const atomicValue = whole * BigInt(10 ** decimals) + BigInt(fraction);
    return new MoneyAmount(atomicValue, decimals);
  }

  toAtomic(): bigint {
    return this.atomicValue;
  }

  toDecimalString(): string {
    const divisor = BigInt(10 ** this.decimals);
    const whole = this.atomicValue / divisor;
    const fraction = this.atomicValue % divisor;
    return `${whole}.${fraction.toString().padStart(this.decimals, '0')}`;
  }

  add(other: MoneyAmount): MoneyAmount {
    if (this.decimals !== other.decimals) {
      throw new Error('Cannot add money with different decimal places');
    }
    return new MoneyAmount(this.atomicValue + other.atomicValue, this.decimals);
  }

  subtract(other: MoneyAmount): MoneyAmount {
    if (this.decimals !== other.decimals) {
      throw new Error('Cannot subtract money with different decimal places');
    }
    if (this.atomicValue < other.atomicValue) {
      throw new Error('Subtraction would result in negative amount');
    }
    return new MoneyAmount(this.atomicValue - other.atomicValue, this.decimals);
  }
}
```

### 4. Remove computeSettlementBreakdown

**File**: `backend/src/domain/settlement.ts`

Delete the entire file or mark as deprecated with clear warning:

```typescript
/**
 * @deprecated Issue #1592
 * DO NOT USE: This function computes settlements off-chain with float arithmetic.
 * All settlement amounts must come from on-chain events or contract state.
 * Use SettlementReader.getSettlement() instead.
 */
export function computeSettlementBreakdown(): never {
  throw new Error(
    'computeSettlementBreakdown is deprecated. ' +
    'Settlement amounts must be read from chain, not computed off-chain. ' +
    'See Issue #1592'
  );
}
```

### 5. Update RoundService

**File**: `backend/src/services/roundService.ts`

Replace any payout computation with settlement reading:

```typescript
import { SettlementReader } from './settlementReader';
import { MoneyAmount } from '../types/money';

export class RoundService {
  constructor(
    // ... existing dependencies
    private readonly settlementReader: SettlementReader
  ) {}

  async recordSettlement(arenaContractId: string, roundNumber: number): Promise<void> {
    const settlement = await this.settlementReader.getSettlement(
      arenaContractId,
      roundNumber
    );

    if (!settlement) {
      // Claim hasn't been executed yet - this is normal
      this.logger.debug(`No settlement found for round ${roundNumber}, claim may be pending`);
      return;
    }

    // Store authoritative amounts
    await this.roundRepository.updateSettlement(roundNumber, {
      settlementTotal: settlement.totalPayout,
      settlementYield: settlement.yieldPortion,
      settlementFee: settlement.platformFee,
      settlementTimestamp: settlement.timestamp,
      settlementVerified: true,
    });

    this.metrics.increment('settlement_records_total', {
      source: 'on_chain',
    });
  }
}
```

### 6. Add Reconciliation Script

**File**: `backend/src/scripts/reconcileSettlements.ts`

```typescript
/**
 * One-time script to backfill settlement amounts from on-chain data
 * and flag historical mismatches between backend computation and chain reality.
 */

import { PrismaClient } from '@prisma/client';
import { SettlementReader } from '../services/settlementReader';

async function reconcileSettlements(dryRun: boolean = true) {
  const prisma = new PrismaClient();
  const reader = new SettlementReader();

  const rounds = await prisma.round.findMany({
    where: {
      state: 'RESOLVED',
      settlementVerified: false,
    },
  });

  let matched = 0;
  let mismatched = 0;
  let pending = 0;

  for (const round of rounds) {
    const settlement = await reader.getSettlement(
      round.arenaContractId,
      round.roundNumber
    );

    if (!settlement) {
      pending++;
      console.log(`Round ${round.roundNumber}: Claim pending`);
      continue;
    }

    // If backend had computed a payout, compare it
    if (round.payoutAmount !== null) {
      const backendAmount = BigInt(round.payoutAmount);
      const chainAmount = settlement.totalPayout;

      if (backendAmount !== chainAmount) {
        mismatched++;
        console.error(
          `MISMATCH Round ${round.roundNumber}: ` +
          `Backend ${backendAmount} !== Chain ${chainAmount} ` +
          `(diff: ${chainAmount - backendAmount})`
        );
      } else {
        matched++;
      }
    }

    if (!dryRun) {
      await prisma.round.update({
        where: { id: round.id },
        data: {
          settlementTotal: settlement.totalPayout,
          settlementYield: settlement.yieldPortion,
          settlementFee: settlement.platformFee,
          settlementTimestamp: settlement.timestamp,
          settlementVerified: true,
        },
      });
    }
  }

  console.log(`\nReconciliation ${dryRun ? '(DRY RUN)' : ''} complete:`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Mismatched: ${mismatched}`);
  console.log(`  Pending claims: ${pending}`);
  console.log(`  Total: ${rounds.length}`);

  if (mismatched > 0) {
    console.error(`\nWARNING: Found ${mismatched} settlements where backend amounts differ from chain!`);
  }
}

// Run with: npx tsx src/scripts/reconcileSettlements.ts [--apply]
const dryRun = !process.argv.includes('--apply');
reconcileSettlements(dryRun);
```

### 7. Add ESLint Rule

**File**: `.eslintrc.js`

```javascript
module.exports = {
  rules: {
    // ... existing rules
    
    // Prevent floating-point arithmetic on money
    'no-restricted-syntax': [
      'error',
      {
        selector: 'BinaryExpression[operator=/[+\\-*\\/]/] > Identifier[name=/amount|payout|stake|yield|fee/i]',
        message: 'Do not use arithmetic operators on money variables. Use MoneyAmount value object instead.',
      },
    ],
  },
};
```

## Testing Strategy

### Unit Tests

**File**: `backend/tests/settlementReader.test.ts`

```typescript
describe('SettlementReader', () => {
  it('reads prize_claimed event for finalized round', async () => {
    const reader = new SettlementReader();
    const settlement = await reader.getPrizeClaimedEvent(CONTRACT_ID, 1);
    
    expect(settlement).not.toBeNull();
    expect(settlement?.totalPayout).toBeInstanceOf(BigInt);
    expect(settlement?.yieldPortion).toBeInstanceOf(BigInt);
  });

  it('returns null when claim not yet executed', async () => {
    const reader = new SettlementReader();
    const settlement = await reader.getPrizeClaimedEvent(CONTRACT_ID, 999);
    
    expect(settlement).toBeNull();
  });

  it('falls back to contract state when event unavailable', async () => {
    const reader = new SettlementReader();
    const settlement = await reader.getSettlement(CONTRACT_ID, 1);
    
    expect(settlement).not.toBeNull();
  });
});
```

### Integration Tests

```typescript
describe('Settlement Integration', () => {
  it('records on-chain settlement amounts correctly', async () => {
    const roundService = new RoundService(...);
    
    await roundService.recordSettlement(CONTRACT_ID, 1);
    
    const round = await prisma.round.findFirst({
      where: { roundNumber: 1 },
    });
    
    expect(round?.settlementVerified).toBe(true);
    expect(round?.settlementTotal).toBeInstanceOf(BigInt);
  });

  it('handles missing claim gracefully', async () => {
    const roundService = new RoundService(...);
    
    await expect(
      roundService.recordSettlement(CONTRACT_ID, 999)
    ).resolves.not.toThrow();
  });
});
```

## Acceptance Criteria Checklist

- [ ] `computeSettlementBreakdown` removed or throws error
- [ ] `SettlementReader` reads `prize_claimed` events
- [ ] Settlement amounts stored as bigint in database
- [ ] `MoneyAmount` value object for exact arithmetic
- [ ] Database migration adds settlement columns
- [ ] Reconciliation script compares historical data
- [ ] Tests cover: settlement read, cancelled arena, missing event
- [ ] ESLint rule prevents float arithmetic on money
- [ ] API returns amounts as decimal strings
- [ ] Documentation updated

## Migration Steps

1. **Add new columns** (non-breaking, columns nullable)
2. **Deploy reconciliation script** (read-only, flag mismatches)
3. **Review mismatches** (understand discrepancies)
4. **Backfill settlements** (run script with --apply)
5. **Deploy code** with SettlementReader
6. **Remove computeSettlementBreakdown** (breaking change, throws error)
7. **Monitor metrics** for settlement_records_total

## Rollback Plan

If issues arise:
1. New columns are nullable, old code unaffected
2. Can revert to float computation temporarily
3. Settlement data still available on-chain
4. Reconciliation script can re-run safely

## Future Enhancements

- Event subscription for real-time settlement recording
- Platform/host fee support when contract adds it
- Handle contract upgrades with changed event payload
- Cache settlement data in Redis for faster reads
