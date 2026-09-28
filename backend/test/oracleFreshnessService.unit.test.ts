import {
  classifyFreshness,
  OracleFreshnessService,
  StaleOracleDataError,
  toKeeperStatus,
  type OracleReading,
  type OracleReader,
} from '../src/services/oracleFreshnessService';
import type { OracleFreshnessConfig } from '../src/config/oracleFreshnessConfig';

const POLICY: Pick<OracleFreshnessConfig, 'maxAgeSeconds' | 'warnAgeSeconds'> = {
  maxAgeSeconds: 3_600,
  warnAgeSeconds: 1_800,
};

const FULL_CONFIG: OracleFreshnessConfig = {
  version: 1,
  maxAgeSeconds: 3_600,
  warnAgeSeconds: 1_800,
};

function reading(observedAt: number, rateBps = 500, sourceVersion = 1): OracleReading {
  return { rateBps, observedAt, sourceVersion };
}

describe('classifyFreshness', () => {
  const now = 100_000;

  it('normal elimination path input: a recent reading classifies as fresh', () => {
    const result = classifyFreshness(now, reading(now - 100), POLICY);
    expect(result).toMatchObject({ freshness: 'fresh', ageSeconds: 100 });
  });

  it('exact threshold: age === warnAgeSeconds is warning, not fresh', () => {
    const result = classifyFreshness(now, reading(now - POLICY.warnAgeSeconds), POLICY);
    expect(result.freshness).toBe('warning');
  });

  it('exact threshold: one second below warnAgeSeconds is still fresh', () => {
    const result = classifyFreshness(now, reading(now - (POLICY.warnAgeSeconds - 1)), POLICY);
    expect(result.freshness).toBe('fresh');
  });

  it('exact threshold: age === maxAgeSeconds is stale, not warning', () => {
    const result = classifyFreshness(now, reading(now - POLICY.maxAgeSeconds), POLICY);
    expect(result.freshness).toBe('stale');
  });

  it('exact threshold: one second below maxAgeSeconds is still warning', () => {
    const result = classifyFreshness(now, reading(now - (POLICY.maxAgeSeconds - 1)), POLICY);
    expect(result.freshness).toBe('warning');
  });

  it('clock/ledger divergence: a future-dated observation is stale, not fresh', () => {
    const result = classifyFreshness(now, reading(now + 10_000), POLICY);
    expect(result.freshness).toBe('stale');
  });

  it('missing metadata: observedAt === 0 (never observed) is stale', () => {
    const result = classifyFreshness(now, reading(0), POLICY);
    expect(result).toMatchObject({ freshness: 'stale', ageSeconds: null });
  });

  it('oracle upgrade / mixed version: no reading at all (pre-#1512 oracle) is unavailable, not stale', () => {
    const result = classifyFreshness(now, null, POLICY);
    expect(result).toMatchObject({ freshness: 'unavailable', ageSeconds: null, reading: null });
  });

  it('a mismatched sourceVersion does not by itself affect classification', () => {
    const result = classifyFreshness(now, reading(now - 100, 500, 99), POLICY);
    expect(result.freshness).toBe('fresh');
  });
});

describe('OracleFreshnessService.assertFresh', () => {
  function makeService(readerReading: OracleReading | null): OracleFreshnessService {
    const reader: OracleReader = {
      getOracleReading: jest.fn().mockResolvedValue(readerReading),
    };
    return new OracleFreshnessService(reader, FULL_CONFIG);
  }

  it('accepts a fresh reading', async () => {
    const service = makeService(reading(Math.floor(Date.now() / 1000) - 10));
    await expect(service.assertFresh('CORACLE', 'resolve_round')).resolves.toMatchObject({ freshness: 'fresh' });
  });

  it('rollback / reorg proxy: rejects a reading well past max age', async () => {
    const service = makeService(reading(0));
    await expect(service.assertFresh('CORACLE', 'resolve_round')).rejects.toBeInstanceOf(StaleOracleDataError);
  });

  it('does not reject when the oracle is unavailable (unknown reader) — liveness-first', async () => {
    const service = makeService(null);
    await expect(service.assertFresh('CORACLE', 'resolve_round')).resolves.toMatchObject({ freshness: 'unavailable' });
  });
});

describe('toKeeperStatus', () => {
  it('never performs its own fetch — reads only the already-computed classification', () => {
    const classification = classifyFreshness(100_000, reading(100_000 - 2_000), POLICY);
    const status = toKeeperStatus('CORACLE', classification, POLICY);
    expect(status).toMatchObject({
      oracleContractId: 'CORACLE',
      freshness: 'warning',
      ageSeconds: 2_000,
      maxAgeSeconds: 3_600,
      warnAgeSeconds: 1_800,
      overdue: true,
    });
    expect(typeof status.checkedAt).toBe('string');
  });

  it('overdue is false only for a fresh classification', () => {
    const fresh = toKeeperStatus('CORACLE', classifyFreshness(100_000, reading(100_000 - 10), POLICY), POLICY);
    expect(fresh.overdue).toBe(false);
  });
});
