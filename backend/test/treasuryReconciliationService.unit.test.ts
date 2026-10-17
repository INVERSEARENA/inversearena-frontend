import { TreasuryReconciliationService, type TreasuryEventSource } from '../src/services/treasury/treasuryReconciliationService';
import { TreasuryLeaseHeldError } from '../src/services/treasury/treasuryReconciliationCheckpointStore';
import type { TreasuryConfig } from '../src/config/treasuryConfig';

jest.mock('../src/services/ledgerContinuity', () => ({
  getRollbackGuard: jest.fn().mockReturnValue({ isQuarantined: () => false, getEpoch: () => 0 }),
}));
import { getRollbackGuard } from '../src/services/ledgerContinuity';

const ARENA_ID = 'arena-1';
const CONTRACT_ID = 'CARENA00000000000000000000000000000000000000000000000';
const NETWORK = 'Test SDF Network ; September 2015';

const CONFIG: TreasuryConfig = {
  version: 1,
  treasuryDestination: null,
  finalityGraceSeconds: 120,
};

// ─── Minimal in-memory fake of the two Prisma models this service touches ──

function makeFakePrisma() {
  const checkpoints = new Map<string, any>();
  const feeRecords = new Map<string, any>();
  let idCounter = 0;

  function checkpointKey(arenaId: string, network: string) {
    return `${arenaId}::${network}`;
  }
  function recordKey(network: string, sourceTxHash: string, sourceEventId: string) {
    return `${network}::${sourceTxHash}::${sourceEventId}`;
  }

  const treasuryReconciliationCheckpoint = {
    findUnique: async ({ where }: any) => {
      const { arenaId, network } = where.arenaId_network;
      return checkpoints.get(checkpointKey(arenaId, network)) ?? null;
    },
    updateMany: async ({ where, data }: any) => {
      const row = checkpoints.get(checkpointKey(where.arenaId, where.network));
      if (!row) return { count: 0 };
      if (where.leaseOwner !== undefined && row.leaseOwner !== where.leaseOwner) return { count: 0 };
      if (where.OR) {
        const now = new Date();
        const matches = where.OR.some((cond: any) => {
          if ('leaseOwner' in cond) return row.leaseOwner === null;
          if (cond.leaseExpiresAt?.lt) return row.leaseExpiresAt !== null && row.leaseExpiresAt < now;
          return false;
        });
        if (!matches) return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    },
    create: async ({ data }: any) => {
      const key = checkpointKey(data.arenaId, data.network);
      if (checkpoints.has(key)) {
        const err: any = new Error('unique constraint');
        err.code = 'P2002';
        throw err;
      }
      const row = {
        id: String(idCounter++),
        lastKnownFeeBps: 1000,
        status: 'idle',
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      checkpoints.set(key, row);
      return row;
    },
    upsert: async ({ where, create, update }: any) => {
      const { arenaId, network } = where.arenaId_network;
      const key = checkpointKey(arenaId, network);
      const existing = checkpoints.get(key);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = {
        id: String(idCounter++),
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      checkpoints.set(key, row);
      return row;
    },
  };

  const treasuryFeeRecord = {
    upsert: async ({ where, create, update }: any) => {
      const { network, sourceTxHash, sourceEventId } = where.network_sourceTxHash_sourceEventId;
      const key = recordKey(network, sourceTxHash, sourceEventId);
      const existing = feeRecords.get(key);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = { id: String(idCounter++), createdAt: new Date(), updatedAt: new Date(), ...create };
      feeRecords.set(key, row);
      return row;
    },
    findMany: async () => Array.from(feeRecords.values()),
  };

  return { treasuryReconciliationCheckpoint, treasuryFeeRecord, __feeRecords: feeRecords, __checkpoints: checkpoints } as any;
}

function claimedEvent(overrides: Partial<{
  id: string;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
  winner: string;
  amountAtomic: bigint;
  yieldAmountAtomic: bigint;
}> = {}) {
  return {
    topic: 'claimed' as const,
    id: overrides.id ?? 'evt-1',
    ledgerSequence: overrides.ledgerSequence ?? 1000,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '2020-01-01T00:00:00.000Z',
    txHash: overrides.txHash ?? 'tx-1',
    winner: overrides.winner ?? 'GWINNER',
    amountAtomic: overrides.amountAtomic ?? 11_000_000n,
    yieldAmountAtomic: overrides.yieldAmountAtomic ?? 1_000_000n,
  };
}

function feeUpdatedEvent(overrides: Partial<{ id: string; ledgerSequence: number; ledgerClosedAt: string; txHash: string; admin: string; feeBps: number }> = {}) {
  return {
    topic: 'fee_upd' as const,
    id: overrides.id ?? 'evt-fee',
    ledgerSequence: overrides.ledgerSequence ?? 500,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '2020-01-01T00:00:00.000Z',
    txHash: overrides.txHash ?? 'tx-fee',
    admin: overrides.admin ?? 'GADMIN',
    feeBps: overrides.feeBps ?? 250,
  };
}

function makeEventSource(pages: any[][]): TreasuryEventSource {
  let call = 0;
  return {
    getTreasuryEvents: jest.fn().mockImplementation(async () => {
      const events = pages[call] ?? [];
      const isLast = call >= pages.length - 1;
      call++;
      return { events, latestLedger: 999_999, cursor: isLast ? null : `cursor-${call}` };
    }),
  };
}

describe('TreasuryReconciliationService.reconcileArena', () => {
  beforeEach(() => {
    (getRollbackGuard as jest.Mock).mockReturnValue({ isQuarantined: () => false, getEpoch: () => 0 });
  });

  it('normal case: derives an expected platform fee and marks it discrepant/missing_transfer once finalized', async () => {
    const prisma = makeFakePrisma();
    const source = makeEventSource([[claimedEvent()]]);
    const service = new TreasuryReconciliationService(prisma, source, CONFIG, 60_000, 1000);

    const result = await service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");

    expect(result.recordsWritten).toBe(1);
    const record = Array.from(prisma.__feeRecords.values())[0];
    expect(record.expectedAmountAtomic).toBe(100_000n); // 1_000_000 * 1000bps default / 10000
    expect(record.status).toBe('discrepant');
    expect(record.discrepancyType).toBe('missing_transfer');
  });

  it('zero-fee configuration: a claim with 0 configured fee bps reconciles as balanced', async () => {
    const prisma = makeFakePrisma();
    const source = makeEventSource([[feeUpdatedEvent({ feeBps: 0, ledgerSequence: 500 }), claimedEvent({ ledgerSequence: 1000 })]]);
    const service = new TreasuryReconciliationService(prisma, source, CONFIG, 60_000, 1000);

    await service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");

    const record = Array.from(prisma.__feeRecords.values())[0];
    expect(record.expectedAmountAtomic).toBe(0n);
    expect(record.status).toBe('balanced');
    expect(record.discrepancyType).toBeNull();
  });

  it('config changes: a fee_upd between two claims applies the correct bps to each', async () => {
    const prisma = makeFakePrisma();
    const source = makeEventSource([
      [
        claimedEvent({ id: 'evt-a', txHash: 'tx-a', ledgerSequence: 100, yieldAmountAtomic: 1_000_000n }),
        feeUpdatedEvent({ ledgerSequence: 200, feeBps: 500 }),
        claimedEvent({ id: 'evt-b', txHash: 'tx-b', ledgerSequence: 300, yieldAmountAtomic: 1_000_000n }),
      ],
    ]);
    const service = new TreasuryReconciliationService(prisma, source, CONFIG, 60_000, 1000);

    await service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");

    const recordA = prisma.__feeRecords.get(`${NETWORK}::tx-a::evt-a`);
    const recordB = prisma.__feeRecords.get(`${NETWORK}::tx-b::evt-b`);
    expect(recordA.feeBpsApplied).toBe(1000); // default, before the fee_upd
    expect(recordA.expectedAmountAtomic).toBe(100_000n);
    expect(recordB.feeBpsApplied).toBe(500); // after the fee_upd
    expect(recordB.expectedAmountAtomic).toBe(50_000n);
  });

  it('partial batches: a multi-page event source is fully processed and each page checkpoints', async () => {
    const prisma = makeFakePrisma();
    const source = makeEventSource([
      [claimedEvent({ id: 'evt-a', txHash: 'tx-a', ledgerSequence: 100 })],
      [claimedEvent({ id: 'evt-b', txHash: 'tx-b', ledgerSequence: 200 })],
      [claimedEvent({ id: 'evt-c', txHash: 'tx-c', ledgerSequence: 300 })],
    ]);
    const service = new TreasuryReconciliationService(prisma, source, CONFIG, 60_000, 1000);

    const result = await service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");

    expect(result.recordsWritten).toBe(3);
    expect(result.lastLedgerSequence).toBe(300);
    expect((source.getTreasuryEvents as jest.Mock).mock.calls.length).toBe(3);
  });

  it('duplicate events: re-ingesting the same event upserts the same record instead of duplicating it', async () => {
    const prisma = makeFakePrisma();
    const event = claimedEvent();
    const service1 = new TreasuryReconciliationService(prisma, makeEventSource([[event]]), CONFIG, 60_000, 1000);
    await service1.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");
    expect(prisma.__feeRecords.size).toBe(1);

    // Simulate a re-scan from genesis (as if the checkpoint were reset) delivering the same event again.
    prisma.__checkpoints.delete(`${ARENA_ID}::${NETWORK}`);
    const service2 = new TreasuryReconciliationService(prisma, makeEventSource([[event]]), CONFIG, 60_000, 1000);
    await service2.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");

    expect(prisma.__feeRecords.size).toBe(1); // still exactly one row, not two
  });

  it('rollback: while a ledger rollback is being recovered from, records stay pending past the finality window', async () => {
    (getRollbackGuard as jest.Mock).mockReturnValue({ isQuarantined: () => true, getEpoch: () => 3 });
    const prisma = makeFakePrisma();
    // Ledger closed long ago — would normally be well past the finality grace window.
    const source = makeEventSource([[claimedEvent({ ledgerClosedAt: '2000-01-01T00:00:00.000Z' })]]);
    const service = new TreasuryReconciliationService(prisma, source, CONFIG, 60_000, 1000);

    await service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM");

    const record = Array.from(prisma.__feeRecords.values())[0];
    expect(record.status).toBe('pending');
    expect(record.discrepancyType).toBe('unfinalized_ledger');
  });

  it('concurrent reconciliation: a second run for the same arena is rejected while the first holds the lease', async () => {
    const prisma = makeFakePrisma();
    // Pre-claim the lease as if another process is mid-run.
    await prisma.treasuryReconciliationCheckpoint.create({
      data: { arenaId: ARENA_ID, network: NETWORK, lastLedgerSequence: -1, leaseOwner: 'other-process', leaseExpiresAt: new Date(Date.now() + 60_000) },
    });

    const service = new TreasuryReconciliationService(prisma, makeEventSource([[claimedEvent()]]), CONFIG, 60_000, 1000);

    await expect(service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, "XLM")).rejects.toBeInstanceOf(TreasuryLeaseHeldError);
    expect(prisma.__feeRecords.size).toBe(0);
  });

  it('multi-asset decimals: a USDC-denominated arena (6 decimals) reconciles correctly and records its own asset code', async () => {
    const prisma = makeFakePrisma();
    // 1234.56789 USDC-scale (6 decimals) yield at 250 bps — seed a fee_upd
    // first so the default 1000bps doesn't mask the check.
    const source = makeEventSource([[feeUpdatedEvent({ feeBps: 250, ledgerSequence: 1 }), claimedEvent({ yieldAmountAtomic: 1_234_567_890n, ledgerSequence: 2 })]]);
    const service = new TreasuryReconciliationService(prisma, source, CONFIG, 60_000, 1000);

    await service.reconcileArena(ARENA_ID, CONTRACT_ID, NETWORK, 'USDC');

    const record = Array.from(prisma.__feeRecords.values())[0];
    expect(record.expectedAmountAtomic).toBe(30_864_197n); // floor(1_234_567_890 * 250 / 10000)
    expect(record.asset).toBe('USDC');
  });
});
