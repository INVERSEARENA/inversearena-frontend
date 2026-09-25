import {
  RoundProofBundleService,
  RoundNotResolvedError,
  RoundProofBundleUnavailableError,
  RoundProofBundleAssemblyError,
} from '../src/services/roundProofBundleService';
import { RoundState } from '../src/types/round';
import type { StellarConfig } from '../src/config/stellarConfig';

const FAKE_STELLAR_CONFIG: StellarConfig = {
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  roundConfirmPollMs: 1,
  roundConfirmMaxPolls: 1,
};

const ARENA_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const ROUND_ID = '11111111-1111-1111-1111-111111111111';
const ARENA_ID = '22222222-2222-2222-2222-222222222222';

function buildRound(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ROUND_ID,
    arenaId: ARENA_ID,
    roundNumber: 3,
    state: 'RESOLVED',
    metadata: {
      playerChoices: [
        { userId: 'p1', choice: 'heads', stake: 100 },
        { userId: 'p2', choice: 'tails', stake: 100 },
        { userId: 'p3', choice: 'tails', stake: 100 },
      ],
      oracleYield: 5,
      randomSeed: 'seed',
      resolution: {
        eliminatedPlayers: ['p2', 'p3'],
        payouts: [{ userId: 'p1', amount: 300 }],
        poolBalances: {},
      },
      allActivePlayerIds: ['p1', 'p2', 'p3'],
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  };
}

function buildPrismaMock(round: unknown, arena: unknown = { metadata: { contractAddress: ARENA_CONTRACT_ID } }) {
  return {
    round: {
      findUnique: jest.fn().mockResolvedValue(round),
    },
    arena: {
      findUnique: jest.fn().mockResolvedValue(arena),
    },
  } as any;
}

describe('RoundProofBundleService.getProofBundle', () => {
  it('assembles a bundle for a normally resolved round with a correct checksum and minority-wins tally', async () => {
    const prisma = buildPrismaMock(buildRound());
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID);

    expect(bundle.version).toBe(1);
    expect(bundle.roundId).toBe(ROUND_ID);
    expect(bundle.arenaId).toBe(ARENA_ID);
    expect(bundle.network).toEqual({
      passphrase: FAKE_STELLAR_CONFIG.networkPassphrase,
      arenaContractId: ARENA_CONTRACT_ID,
    });
    expect(bundle.allActivePlayerIds).toEqual(['p1', 'p2', 'p3']);
    expect(bundle.playerChoices).toEqual([
      { userId: 'p1', choice: 'heads' },
      { userId: 'p2', choice: 'tails' },
      { userId: 'p3', choice: 'tails' },
    ]);
    expect(bundle.tally).toEqual({ heads: 1, tails: 2 });
    expect(bundle.eliminatedPlayers).toEqual(['p2', 'p3']);
    expect(bundle.survivors).toEqual(['p1']);
    expect(typeof bundle.checksum).toBe('string');
    expect(bundle.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof bundle.generatedAt).toBe('string');
  });

  it('includes non-revealers in allActivePlayerIds and eliminatedPlayers even though they have no playerChoices entry (AFK elimination)', async () => {
    // p4 was active entering the round but never revealed; the contract
    // eliminates non-revealers unconditionally (see lib.rs resolve_players).
    const round = buildRound({
      metadata: {
        playerChoices: [
          { userId: 'p1', choice: 'heads', stake: 100 },
          { userId: 'p2', choice: 'tails', stake: 100 },
        ],
        oracleYield: 5,
        randomSeed: 'seed',
        resolution: {
          eliminatedPlayers: ['p2', 'p4'],
          payouts: [{ userId: 'p1', amount: 300 }],
          poolBalances: {},
        },
        allActivePlayerIds: ['p1', 'p2', 'p4'],
      },
    });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID);

    expect(bundle.allActivePlayerIds).toEqual(['p1', 'p2', 'p4']);
    expect(bundle.playerChoices.map((c) => c.userId)).toEqual(['p1', 'p2']);
    expect(bundle.eliminatedPlayers).toEqual(['p2', 'p4']);
    expect(bundle.survivors).toEqual(['p1']);
  });

  it('produces a tie tally (heads === tails) verbatim without inventing an eliminated revealer', async () => {
    const round = buildRound({
      metadata: {
        playerChoices: [
          { userId: 'p1', choice: 'heads', stake: 100 },
          { userId: 'p2', choice: 'tails', stake: 100 },
        ],
        oracleYield: 0,
        randomSeed: 'seed',
        resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
        allActivePlayerIds: ['p1', 'p2'],
      },
    });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID);

    expect(bundle.tally).toEqual({ heads: 1, tails: 1 });
    expect(bundle.eliminatedPlayers).toEqual([]);
    expect(bundle.survivors).toEqual(['p1', 'p2']);
  });

  it('boundary: a single active player with no opposing votes all survive', async () => {
    const round = buildRound({
      metadata: {
        playerChoices: [{ userId: 'p1', choice: 'heads', stake: 100 }],
        oracleYield: 0,
        randomSeed: 'seed',
        resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
        allActivePlayerIds: ['p1'],
      },
    });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID);
    expect(bundle.tally).toEqual({ heads: 1, tails: 0 });
    expect(bundle.survivors).toEqual(['p1']);
  });

  it('is idempotent: repeated calls for the same round produce byte-identical bundles (duplicate delivery / concurrent requests)', async () => {
    const prisma = buildPrismaMock(buildRound());
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const [first, second, third] = await Promise.all([
      service.getProofBundle(ROUND_ID),
      service.getProofBundle(ROUND_ID),
      service.getProofBundle(ROUND_ID),
    ]);

    // generatedAt legitimately differs call to call (each call stamps its own
    // assembly time), and since checksum is computed over the whole bundle
    // INCLUDING generatedAt, the checksums legitimately differ too. What must
    // stay byte-identical across duplicate/concurrent calls is the underlying
    // *claim* — every field except generatedAt/checksum.
    const strip = (b: typeof first) => {
      const { generatedAt, checksum, ...claim } = b;
      return claim;
    };
    expect(strip(first)).toEqual(strip(second));
    expect(strip(second)).toEqual(strip(third));
  });

  it('invalid input: throws RoundNotResolvedError for an OPEN round and does not retry (single findUnique call)', async () => {
    const round = buildRound({ state: 'OPEN', metadata: null });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    await expect(service.getProofBundle(ROUND_ID)).rejects.toBeInstanceOf(RoundNotResolvedError);
    expect(prisma.round.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalid input: throws a plain not-found Error when the round does not exist', async () => {
    const prisma = buildPrismaMock(null);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    await expect(service.getProofBundle('missing-round')).rejects.toThrow(/not found/);
  });

  it('invalid input: throws RoundProofBundleAssemblyError when a RESOLVED round has no resolution metadata (partial-failure / restart-during-work)', async () => {
    const round = buildRound({
      metadata: {
        playerChoices: [],
        oracleYield: 0,
        randomSeed: undefined,
        resolution: undefined,
        allActivePlayerIds: ['p1'],
      },
    });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    await expect(service.getProofBundle(ROUND_ID)).rejects.toBeInstanceOf(RoundProofBundleAssemblyError);
  });

  it('invalid input: throws RoundProofBundleUnavailableError for a legacy round with no persisted allActivePlayerIds, and does not retry', async () => {
    const round = buildRound({
      metadata: {
        playerChoices: [{ userId: 'p1', choice: 'heads', stake: 100 }],
        oracleYield: 0,
        randomSeed: 'seed',
        resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
        allActivePlayerIds: undefined,
      },
    });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    await expect(service.getProofBundle(ROUND_ID)).rejects.toBeInstanceOf(RoundProofBundleUnavailableError);
    expect(prisma.round.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalid input: throws RoundProofBundleAssemblyError when the arena has no on-chain contractAddress recorded', async () => {
    const prisma = buildPrismaMock(buildRound(), { metadata: {} });
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    await expect(service.getProofBundle(ROUND_ID)).rejects.toBeInstanceOf(RoundProofBundleAssemblyError);
  });

  it('retry: retries transient failures (e.g. a flaky read) up to maxRetries then succeeds', async () => {
    const prisma = buildPrismaMock(buildRound());
    prisma.round.findUnique
      .mockRejectedValueOnce(new Error('transient read error'))
      .mockResolvedValue(buildRound());
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID, { maxRetries: 2, retryDelayMs: 1 });

    expect(bundle.roundId).toBe(ROUND_ID);
    expect(prisma.round.findUnique).toHaveBeenCalledTimes(2);
  });

  it('retry: gives up after maxRetries and surfaces the last error', async () => {
    const prisma = buildPrismaMock(buildRound());
    prisma.round.findUnique.mockRejectedValue(new Error('persistent read error'));
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    await expect(
      service.getProofBundle(ROUND_ID, { maxRetries: 2, retryDelayMs: 1 }),
    ).rejects.toThrow('persistent read error');
    // initial attempt + 2 retries = 3 calls
    expect(prisma.round.findUnique).toHaveBeenCalledTimes(3);
  });

  it('boundary: handles a maximum-size round (500 active players) without error', async () => {
    const allActivePlayerIds = Array.from({ length: 500 }, (_, i) => `p${i}`);
    const playerChoices = allActivePlayerIds.map((userId, i) => ({
      userId,
      choice: i % 3 === 0 ? 'tails' : 'heads',
      stake: 100,
    }));
    const eliminatedPlayers = playerChoices.filter((c) => c.choice === 'tails').map((c) => c.userId);
    const round = buildRound({
      metadata: {
        playerChoices,
        oracleYield: 0,
        randomSeed: 'seed',
        resolution: { eliminatedPlayers, payouts: [], poolBalances: {} },
        allActivePlayerIds,
      },
    });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID);
    expect(bundle.allActivePlayerIds).toHaveLength(500);
    expect(bundle.playerChoices).toHaveLength(500);
  });
});

describe('RoundProofBundleService.getProofBundle — SETTLED rounds', () => {
  it('assembles a bundle for a SETTLED round the same as a RESOLVED one', async () => {
    const round = buildRound({ state: RoundState.SETTLED });
    const prisma = buildPrismaMock(round);
    const service = new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);

    const bundle = await service.getProofBundle(ROUND_ID);
    expect(bundle.survivors).toEqual(['p1']);
  });
});
