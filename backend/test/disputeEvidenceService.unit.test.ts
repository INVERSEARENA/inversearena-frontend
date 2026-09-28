import {
  DisputeEvidenceService,
  EvidenceNotParticipantError,
  EvidenceArenaNotFoundError,
  EvidenceRoundNotFoundError,
} from '../src/services/disputeEvidenceService';
import { RoundProofBundleUnavailableError, RoundNotResolvedError } from '../src/services/roundProofBundleService';
import { Money } from '../src/types/money';
import { verifyEvidencePackage } from '../src/utils/evidenceChecksum';
import type { CommitReceipt, RoundProofBundle } from '../src/types/round';
import type { ArenaRefundRecovery } from '../src/services/disputeEvidenceService';

const ARENA_ID = 'arena-1';
const ROUND_NUMBER = 3;
const ROUND_ID = 'round-uuid-1';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const WALLET_ADDRESS = 'GABCDEF1234567890REQUESTOR0000000000000000000000000000';

const BASE_ROUND_ROW = {
  id: ROUND_ID,
  arenaId: ARENA_ID,
  roundNumber: ROUND_NUMBER,
  state: 'RESOLVED',
  metadata: null,
  oracleYield: 5,
  randomSeed: 'a'.repeat(64),
  playerChoices: [{ userId: USER_ID, choice: 'heads', stake: 100 }],
  allActivePlayerIds: [USER_ID, OTHER_USER_ID],
  resolution: { eliminatedPlayers: [USER_ID], payouts: [], poolBalances: {} },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

function makePrismaStub(overrides: {
  arena?: unknown;
  round?: unknown;
  eliminationLog?: unknown;
} = {}) {
  return {
    arena: {
      findUnique: async () => (overrides.arena === undefined ? { id: ARENA_ID, metadata: { contractAddress: 'CARENA1234567890' } } : overrides.arena),
    },
    round: {
      findUnique: async () => (overrides.round === undefined ? BASE_ROUND_ROW : overrides.round),
    },
    eliminationLog: {
      findFirst: async () => (overrides.eliminationLog === undefined ? null : overrides.eliminationLog),
    },
  } as any;
}

function makeCommitReceipt(overrides: Partial<CommitReceipt> & { status: CommitReceipt['status'] }): CommitReceipt {
  return {
    arenaId: ARENA_ID,
    roundNumber: ROUND_NUMBER,
    walletAddress: WALLET_ADDRESS,
    asOf: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeProofBundle(overrides: Partial<RoundProofBundle> = {}): RoundProofBundle {
  return {
    version: 1,
    roundId: ROUND_ID,
    arenaId: ARENA_ID,
    roundNumber: ROUND_NUMBER,
    network: { passphrase: 'Test SDF Network ; September 2015', arenaContractId: 'CARENA1234567890' },
    playerChoices: [{ userId: USER_ID, choice: 'heads' }],
    allActivePlayerIds: [USER_ID, OTHER_USER_ID],
    tally: { heads: 1, tails: 1 },
    eliminatedPlayers: [USER_ID],
    survivors: [OTHER_USER_ID],
    checksum: 'deadbeef',
    generatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeService(opts: {
  prisma?: ReturnType<typeof makePrismaStub>;
  commitReceipt?: CommitReceipt;
  proofBundle?: RoundProofBundle | Error;
  recovery?: ArenaRefundRecovery | null;
} = {}) {
  const prisma = opts.prisma ?? makePrismaStub();

  const roundService = {
    getCommitStatus: jest.fn().mockResolvedValue(opts.commitReceipt ?? makeCommitReceipt({ status: 'accepted', choice: 'heads' })),
  } as any;

  const proofBundleService = {
    getProofBundle: opts.proofBundle instanceof Error
      ? jest.fn().mockRejectedValue(opts.proofBundle)
      : jest.fn().mockResolvedValue(opts.proofBundle ?? makeProofBundle()),
  } as any;

  const cancellationRecoveryService = {
    getArenaRecovery: jest.fn().mockResolvedValue(opts.recovery ?? null),
  } as any;

  const stellarConfig = {
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    roundConfirmPollMs: 1000,
    roundConfirmMaxPolls: 1,
  };

  const service = new DisputeEvidenceService(
    prisma,
    roundService,
    proofBundleService,
    cancellationRecoveryService,
    stellarConfig,
  );

  return { service, roundService, proofBundleService, cancellationRecoveryService, prisma };
}

// negotiateCapability/getCurrentLedgerSequence/getRollbackGuard are pure
// module-level singletons this service imports directly (not injected) —
// mocked here so unit tests never attempt real RPC calls.
jest.mock('../src/services/contractCapability', () => ({
  negotiateCapability: jest.fn().mockResolvedValue(3),
}));
jest.mock('../src/services/ledgerClock', () => ({
  getCurrentLedgerSequence: jest.fn().mockResolvedValue(123456),
}));
jest.mock('../src/services/ledgerContinuity', () => ({
  getRollbackGuard: jest.fn().mockReturnValue({ isQuarantined: () => false, getEpoch: () => 0 }),
}));

import { getRollbackGuard } from '../src/services/ledgerContinuity';
import { negotiateCapability } from '../src/services/contractCapability';
import { getCurrentLedgerSequence } from '../src/services/ledgerClock';

describe('DisputeEvidenceService.generatePackage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getRollbackGuard as jest.Mock).mockReturnValue({ isQuarantined: () => false, getEpoch: () => 0 });
    (negotiateCapability as jest.Mock).mockResolvedValue(3);
    (getCurrentLedgerSequence as jest.Mock).mockResolvedValue(123456);
  });

  it('normal elimination: returns a self-verifying package with the player marked eliminated', async () => {
    const { service } = makeService();

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    expect(pkg.schemaVersion).toBe(1);
    expect(pkg.player.eliminated).toBe(true);
    expect(pkg.player.survived).toBe(false);
    expect(pkg.aggregate.totalEliminated).toBe(1);
    expect(pkg.aggregate.totalSurvivors).toBe(1);
    expect(pkg.unavailable).toEqual([]);
    expect(pkg.decisionRecords.some((r) => r.type === 'ELIMINATION')).toBe(true);

    const verification = verifyEvidencePackage(pkg);
    expect(verification.valid).toBe(true);
  });

  it('non-reveal: a non-revealing but active/eliminated player is still recognized as a participant', async () => {
    const round = {
      ...BASE_ROUND_ROW,
      playerChoices: [], // player never revealed
      allActivePlayerIds: [USER_ID, OTHER_USER_ID],
    };
    const { service } = makeService({
      prisma: makePrismaStub({ round }),
      commitReceipt: makeCommitReceipt({ status: 'missing', reason: 'NO_COMMIT_RECORDED' }),
      proofBundle: makeProofBundle({ eliminatedPlayers: [USER_ID], survivors: [OTHER_USER_ID] }),
    });

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    expect(pkg.player.eliminated).toBe(true);
    expect(pkg.player.revealedChoice).toBeUndefined();
    const commitRecord = pkg.decisionRecords.find((r) => r.type === 'COMMIT_STATUS');
    expect(commitRecord?.data).toMatchObject({ status: 'missing', reason: 'NO_COMMIT_RECORDED' });
  });

  it('claim/payout: includes a PAYOUT decision record with the settlement breakdown for the winner', async () => {
    const payoutMoney = () => new Money(1_000_000n, 'USDC');
    const round = {
      ...BASE_ROUND_ROW,
      resolution: {
        eliminatedPlayers: [OTHER_USER_ID],
        payouts: [
          {
            userId: USER_ID,
            amount: payoutMoney(),
            principal: payoutMoney(),
            yieldAmount: payoutMoney(),
            platformFee: payoutMoney(),
            dust: payoutMoney(),
          },
        ],
        poolBalances: {},
      },
    };
    const { service } = makeService({
      prisma: makePrismaStub({ round }),
      proofBundle: makeProofBundle({ eliminatedPlayers: [OTHER_USER_ID], survivors: [USER_ID] }),
    });

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    const payoutRecord = pkg.decisionRecords.find((r) => r.type === 'PAYOUT');
    expect(payoutRecord).toBeDefined();
    expect(payoutRecord?.data.amount).toBe('1.00');
  });

  it('refund: includes a REFUND decision record when the arena was cancelled', async () => {
    const recovery: ArenaRefundRecovery = {
      cancelledAt: '2026-01-03T00:00:00.000Z',
      participants: [
        {
          userId: USER_ID,
          recoveryStatus: 'refundable',
          refundAmount: 100,
        },
      ],
    };
    const { service } = makeService({ recovery });

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    const refundRecord = pkg.decisionRecords.find((r) => r.type === 'REFUND');
    expect(refundRecord).toBeDefined();
    expect(refundRecord?.data).toMatchObject({ recoveryStatus: 'refundable', refundAmount: 100 });
  });

  it('missing index data: a legacy round with no proof bundle index degrades gracefully instead of failing outright', async () => {
    const { service } = makeService({
      proofBundle: new RoundProofBundleUnavailableError(ROUND_ID),
    });

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    expect(pkg.player.eliminated).toBeUndefined();
    expect(pkg.unavailable).toContainEqual(
      expect.objectContaining({ field: 'eliminationProof', reason: 'LEGACY_ROUND_NO_INDEX_DATA' }),
    );
    // Other sections still populate normally — partial degradation, not total failure.
    expect(pkg.decisionRecords.some((r) => r.type === 'COMMIT_STATUS')).toBe(true);
  });

  it('round not resolved: surfaces a typed unavailable reason rather than a hard failure', async () => {
    const round = { ...BASE_ROUND_ROW, state: 'OPEN' };
    const { service } = makeService({
      prisma: makePrismaStub({ round }),
      commitReceipt: makeCommitReceipt({ status: 'pending' }),
      proofBundle: new RoundNotResolvedError(ROUND_ID, 'OPEN'),
    });

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    expect(pkg.unavailable).toContainEqual(
      expect.objectContaining({ field: 'eliminationProof', reason: 'ROUND_NOT_RESOLVED' }),
    );
  });

  it('reorg: a ledger rollback in recovery marks the package degraded with a typed unavailable entry', async () => {
    (getRollbackGuard as jest.Mock).mockReturnValue({ isQuarantined: () => true, getEpoch: () => 7 });
    const { service } = makeService();

    const pkg = await service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });

    expect(pkg.freshness.degraded).toBe(true);
    expect(pkg.decisionRecords).toContainEqual(
      expect.objectContaining({ type: 'LEDGER_CONTINUITY', data: { quarantined: true } }),
    );
    expect(pkg.unavailable).toContainEqual(
      expect.objectContaining({ field: 'onChainFreshness', reason: 'LEDGER_ROLLBACK_IN_PROGRESS' }),
    );
  });

  it('cross-wallet access: a wallet with no footprint in the round is rejected, not silently scoped', async () => {
    const round = {
      ...BASE_ROUND_ROW,
      playerChoices: [{ userId: OTHER_USER_ID, choice: 'heads', stake: 100 }],
      allActivePlayerIds: [OTHER_USER_ID],
      resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
    };
    const { service } = makeService({
      prisma: makePrismaStub({ round }),
      commitReceipt: makeCommitReceipt({ status: 'missing', reason: 'NO_COMMIT_RECORDED' }),
    });

    await expect(
      service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS }),
    ).rejects.toBeInstanceOf(EvidenceNotParticipantError);
  });

  it('rejects a nonexistent arena', async () => {
    const { service } = makeService({ prisma: makePrismaStub({ arena: null }) });

    await expect(
      service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS }),
    ).rejects.toBeInstanceOf(EvidenceArenaNotFoundError);
  });

  it('rejects a nonexistent round', async () => {
    const { service } = makeService({ prisma: makePrismaStub({ round: null }) });

    await expect(
      service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS }),
    ).rejects.toBeInstanceOf(EvidenceRoundNotFoundError);
  });
});

describe('verifyEvidencePackage', () => {
  async function generateValidPackage() {
    const { service } = makeService();
    return service.generatePackage(ARENA_ID, ROUND_NUMBER, { userId: USER_ID, walletAddress: WALLET_ADDRESS });
  }

  it('tampering: a package mutated after generation fails checksum verification', async () => {
    const pkg = await generateValidPackage();
    const tampered = { ...pkg, player: { ...pkg.player, eliminated: false } };

    const result = verifyEvidencePackage(tampered);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CHECKSUM_MISMATCH');
  });

  it('mixed versions: a package reporting an unrecognized schema version is flagged rather than trusted', async () => {
    const pkg = await generateValidPackage();
    const mixedVersion = { ...pkg, schemaVersion: 999 };

    const result = verifyEvidencePackage(mixedVersion);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SCHEMA_VERSION_UNKNOWN');
  });

  it('accepts an untampered package generated by the service', async () => {
    const pkg = await generateValidPackage();

    expect(verifyEvidencePackage(pkg)).toMatchObject({ valid: true });
  });
});
