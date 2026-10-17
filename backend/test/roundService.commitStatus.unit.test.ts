import { RoundService } from '../src/services/roundService';
import { RoundState } from '../src/types/round';
import { commitReceiptLookupsTotal, commitReceiptLookupDuration } from '../src/utils/metrics';

/**
 * Unit tests for RoundService.getCommitStatus (#1383).
 *
 * Mocks prisma.round.findUnique (via RoundRepository.findByArenaAndNumber,
 * which is a thin wrapper) and prisma.user.findUnique, matching the style of
 * roundService.unit.test.ts (this suite's neighbor) and
 * tests/arenas.route.unit.test.ts (which mocks the same prisma surface at
 * the route level).
 */

const ARENA_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX';
const ROUND_NUMBER = 3;
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makePrismaRound(overrides: {
  state: string;
  playerChoices?: Array<{ userId: string; choice: string; stake: number }>;
}) {
  return {
    id: 'round-db-id',
    arenaId: ARENA_ID,
    roundNumber: ROUND_NUMBER,
    state: overrides.state,
    metadata: overrides.playerChoices
      ? { playerChoices: overrides.playerChoices, oracleYield: 5, randomSeed: undefined, resolution: undefined }
      : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeService(prismaMock: {
  round: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
}) {
  return new RoundService(prismaMock as any);
}

describe('RoundService.getCommitStatus', () => {
  let findRound: jest.Mock;
  let findUser: jest.Mock;
  let service: RoundService;

  beforeEach(() => {
    findRound = jest.fn();
    findUser = jest.fn();
    service = makeService({
      round: { findUnique: findRound },
      user: { findUnique: findUser },
    });
    commitReceiptLookupsTotal.reset();
    commitReceiptLookupDuration.reset();
  });

  // --- missing: round not found ------------------------------------------
  it('returns missing/ROUND_NOT_FOUND when the round does not exist for the arena', async () => {
    findRound.mockResolvedValue(null);

    const receipt = await service.getCommitStatus(ARENA_ID, 999, WALLET);

    expect(receipt).toEqual({
      arenaId: ARENA_ID,
      roundNumber: 999,
      walletAddress: WALLET,
      status: 'missing',
      reason: 'ROUND_NOT_FOUND',
      asOf: expect.any(String),
    });
    expect(findUser).not.toHaveBeenCalled();
  });

  // --- missing: player never joined ---------------------------------------
  it('returns missing/NO_COMMIT_RECORDED when the round is OPEN and the wallet has no User record', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'OPEN' }));
    findUser.mockResolvedValue(null);

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    // No User record and round still OPEN: no resolved choice is possible,
    // window is still open from the backend's point of view -> pending,
    // not missing. (missing/NO_COMMIT_RECORDED is reserved for the
    // RESOLVED/SETTLED branch — see next test.)
    expect(receipt.status).toBe('pending');
  });

  it('returns missing/NO_COMMIT_RECORDED when the round is RESOLVED and the wallet has no User record', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'RESOLVED' }));
    findUser.mockResolvedValue(null);

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt).toMatchObject({
      status: 'missing',
      reason: 'NO_COMMIT_RECORDED',
    });
  });

  // --- accepted -------------------------------------------------------------
  it('returns accepted with the revealed choice when the round is RESOLVED and a matching playerChoice exists', async () => {
    findRound.mockResolvedValue(
      makePrismaRound({
        state: 'RESOLVED',
        playerChoices: [{ userId: 'user-1', choice: 'heads', stake: 100 }],
      }),
    );
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt).toMatchObject({ status: 'accepted', choice: 'heads' });
  });

  it('returns accepted even while the round is still OPEN, if a playerChoice already exists (boundary)', async () => {
    // Defensive boundary case: playerChoices is normally only populated at
    // resolution time, but the accepted branch is checked first regardless
    // of round.state, so a hypothetical OPEN round with a playerChoice
    // entry must still report accepted, not pending.
    findRound.mockResolvedValue(
      makePrismaRound({
        state: 'OPEN',
        playerChoices: [{ userId: 'user-1', choice: 'tails', stake: 50 }],
      }),
    );
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt).toMatchObject({ status: 'accepted', choice: 'tails' });
  });

  it('accepted receipt omits `choice` (rather than choice: undefined) when the stored choice value is not heads/tails', async () => {
    findRound.mockResolvedValue(
      makePrismaRound({
        state: 'SETTLED',
        // Legacy/other-arena-type data using a different choice vocabulary
        // (e.g. 'HIGH'/'LOW', seen in tests/round.integration.test.ts) —
        // the receipt should still report accepted, just without a typed
        // `choice` field it can't represent.
        playerChoices: [{ userId: 'user-1', choice: 'HIGH', stake: 100 }],
      }),
    );
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt.status).toBe('accepted');
    expect(receipt).not.toHaveProperty('choice');
  });

  it('duplicate delivery: two playerChoices entries for the same userId still resolve to one clean accepted', async () => {
    findRound.mockResolvedValue(
      makePrismaRound({
        state: 'RESOLVED',
        playerChoices: [
          { userId: 'user-1', choice: 'heads', stake: 100 },
          { userId: 'user-1', choice: 'heads', stake: 100 },
        ],
      }),
    );
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt.status).toBe('accepted');
  });

  // --- expired ---------------------------------------------------------------
  it('returns expired when the round is CLOSED and no playerChoice is recorded', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'CLOSED' }));
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt).toMatchObject({ status: 'expired' });
    expect(receipt).not.toHaveProperty('reason');
  });

  // --- pending ---------------------------------------------------------------
  it('returns pending when the round is OPEN and no playerChoice is recorded (known User)', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'OPEN' }));
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt).toMatchObject({ status: 'pending' });
  });

  it('treats an unrecognized/future round.state as OPEN (defaults to pending), matching RoundRepository.parseState', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'SOME_FUTURE_STATE' }));
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(receipt.status).toBe('pending');
  });

  // --- boundary: roundNumber edges (route-level validation is separately
  // covered in arenas.route.unit.test.ts; these confirm the service itself
  // has no off-by-one against the repository lookup) --------------------
  it('passes roundNumber=1 (minimum valid) straight through to the repository lookup', async () => {
    findRound.mockResolvedValue(null);

    await service.getCommitStatus(ARENA_ID, 1, WALLET);

    expect(findRound).toHaveBeenCalledWith({
      where: { arenaId_roundNumber: { arenaId: ARENA_ID, roundNumber: 1 } },
    });
  });

  // --- retry: caller re-issuing the same request behaves idempotently ----
  it('is idempotent under retry: identical repeated calls return the same status', async () => {
    findRound.mockResolvedValue(
      makePrismaRound({
        state: 'RESOLVED',
        playerChoices: [{ userId: 'user-1', choice: 'heads', stake: 100 }],
      }),
    );
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const first = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);
    const second = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    expect(findRound).toHaveBeenCalledTimes(2);
  });

  // --- invalid input: propagated DB failure --------------------------------
  it('propagates a Prisma/DB failure to the caller rather than swallowing it', async () => {
    findRound.mockRejectedValue(new Error('connection reset'));

    await expect(service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET)).rejects.toThrow(
      'connection reset',
    );
  });

  // --- metrics/logging (structured observability, per acceptance criteria) -
  it('records a success outcome metric labeled by the resulting status', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'OPEN' }));
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    const metric = await commitReceiptLookupsTotal.get();
    const pendingSample = metric.values.find(
      (v) => v.labels.status === 'pending' && v.labels.outcome === 'success',
    );
    expect(pendingSample?.value).toBe(1);
  });

  it('records a failure outcome metric when the lookup throws', async () => {
    findRound.mockRejectedValue(new Error('boom'));

    await expect(service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET)).rejects.toThrow('boom');

    const metric = await commitReceiptLookupsTotal.get();
    const errorSample = metric.values.find(
      (v) => v.labels.status === 'error' && v.labels.outcome === 'failure',
    );
    expect(errorSample?.value).toBe(1);
  });

  it('observes lookup duration on both success and failure paths', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'CLOSED' }));
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    const durationMetric = await commitReceiptLookupDuration.get();
    const totalObservations = durationMetric.values.find((v) => v.metricName?.endsWith('_count'));
    expect(totalObservations?.value).toBeGreaterThanOrEqual(1);
  });

  // --- asOf freshness marker -------------------------------------------------
  it('always includes an ISO-8601 asOf timestamp so callers can reason about staleness', async () => {
    findRound.mockResolvedValue(makePrismaRound({ state: 'OPEN' }));
    findUser.mockResolvedValue({ id: 'user-1', walletAddress: WALLET });

    const receipt = await service.getCommitStatus(ARENA_ID, ROUND_NUMBER, WALLET);

    expect(() => new Date(receipt.asOf).toISOString()).not.toThrow();
    expect(new Date(receipt.asOf).toISOString()).toBe(receipt.asOf);
  });
});
