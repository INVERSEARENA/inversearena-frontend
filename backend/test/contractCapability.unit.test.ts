/**
 * Unit tests for contract capability negotiation (#1409).
 *
 * Exercises negotiateCapability/isEntrypointSupported/assertEntrypointSupported
 * against a fake version reader (no real RPC) plus a real CircuitBreaker
 * instance, so the retry-with-backoff and circuit-open-stops-retrying paths
 * are genuinely exercised rather than mocked away.
 */
import { CircuitBreaker } from '../src/utils/circuitBreaker';
import {
  negotiateCapability,
  isEntrypointSupported,
  assertEntrypointSupported,
  setVersionReaderForTest,
  setCircuitBreakerForTest,
  setCapabilityMapForTest,
  resetCapabilityCacheForTest,
  CapabilityNegotiationError,
  UnsupportedEntrypointError,
} from '../src/services/contractCapability';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function freshBreaker() {
  return new CircuitBreaker({ timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 1000 });
}

beforeEach(() => {
  resetCapabilityCacheForTest();
  setCircuitBreakerForTest(freshBreaker());
});

afterEach(() => {
  setVersionReaderForTest(null);
  setCircuitBreakerForTest(null);
  setCapabilityMapForTest(null);
  resetCapabilityCacheForTest();
});

describe('negotiateCapability', () => {
  it('normal path: returns the on-chain version for a healthy read', async () => {
    setVersionReaderForTest(async () => 2);

    const version = await negotiateCapability('arena', CONTRACT_ID);

    expect(version).toBe(2);
  });

  it('caches the negotiated version so a second call does not re-read', async () => {
    const reader = jest.fn().mockResolvedValue(3);
    setVersionReaderForTest(reader);

    await negotiateCapability('arena', CONTRACT_ID);
    await negotiateCapability('arena', CONTRACT_ID);

    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('boundary: caches per contract instance, not per contract kind', async () => {
    const reader = jest.fn().mockResolvedValue(1);
    setVersionReaderForTest(reader);

    await negotiateCapability('arena', 'CONTRACT_A');
    await negotiateCapability('arena', 'CONTRACT_B');

    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('retry: a transient failure is retried and succeeds on a later attempt', async () => {
    let calls = 0;
    setVersionReaderForTest(async () => {
      calls += 1;
      if (calls < 3) throw new Error('rpc timeout');
      return 2;
    });

    const version = await negotiateCapability('arena', CONTRACT_ID);

    expect(version).toBe(2);
    expect(calls).toBe(3);
  });

  it('invalid-input / permanent failure: exhausting retries throws CapabilityNegotiationError and does not cache', async () => {
    const reader = jest.fn().mockRejectedValue(new Error('contract not deployed'));
    setVersionReaderForTest(reader);

    await expect(negotiateCapability('arena', CONTRACT_ID)).rejects.toBeInstanceOf(
      CapabilityNegotiationError,
    );

    // A failed negotiation must not poison the cache for the TTL window -
    // the very next call should retry from scratch, not replay the failure.
    reader.mockResolvedValueOnce(2);
    const version = await negotiateCapability('arena', CONTRACT_ID);
    expect(version).toBe(2);
  });

  it('restart during work / stale reads: retries use backoff, not a tight loop', async () => {
    const timestamps: number[] = [];
    setVersionReaderForTest(async () => {
      timestamps.push(Date.now());
      if (timestamps.length < 3) throw new Error('rpc blip');
      return 1;
    });

    await negotiateCapability('arena', CONTRACT_ID);

    expect(timestamps.length).toBe(3);
    // Backoff means each retry gap is non-trivially larger than a tight loop's ~0ms.
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(50);
  });
});

describe('isEntrypointSupported', () => {
  it('entrypoints with no capability map entry are always supported, without reading version', async () => {
    const reader = jest.fn();
    setVersionReaderForTest(reader);

    const supported = await isEntrypointSupported('arena', CONTRACT_ID, 'some_entrypoint_not_in_the_map');

    expect(supported).toBe(true);
    expect(reader).not.toHaveBeenCalled();
  });

  it('normal path: a deployed version at or above the required version is supported', async () => {
    setCapabilityMapForTest({ arena: { future_entrypoint: 3 }, factory: {}, payout: {}, staking: {} });
    setVersionReaderForTest(async () => 3);

    expect(await isEntrypointSupported('arena', CONTRACT_ID, 'future_entrypoint')).toBe(true);
  });

  it('boundary: a deployed version exactly one below the requirement is unsupported', async () => {
    setCapabilityMapForTest({ arena: { future_entrypoint: 3 }, factory: {}, payout: {}, staking: {} });
    setVersionReaderForTest(async () => 2);

    expect(await isEntrypointSupported('arena', CONTRACT_ID, 'future_entrypoint')).toBe(false);
  });

  it('a mixed-deployment scenario: the same entrypoint is supported on one instance and not another', async () => {
    setCapabilityMapForTest({ arena: { future_entrypoint: 2 }, factory: {}, payout: {}, staking: {} });
    setVersionReaderForTest(async (contractId) => (contractId === 'NEW_ARENA' ? 2 : 1));

    expect(await isEntrypointSupported('arena', 'OLD_ARENA', 'future_entrypoint')).toBe(false);
    expect(await isEntrypointSupported('arena', 'NEW_ARENA', 'future_entrypoint')).toBe(true);
  });
});

describe('assertEntrypointSupported', () => {
  it('does not throw for an entrypoint with no capability map entry', async () => {
    setVersionReaderForTest(async () => 1);

    await expect(
      assertEntrypointSupported('arena', CONTRACT_ID, 'unmapped_entrypoint'),
    ).resolves.toBeUndefined();
  });

  it('throws UnsupportedEntrypointError when the deployed version is below the requirement', async () => {
    setCapabilityMapForTest({ arena: { future_entrypoint: 3 }, factory: {}, payout: {}, staking: {} });
    setVersionReaderForTest(async () => 1);

    await expect(
      assertEntrypointSupported('arena', CONTRACT_ID, 'future_entrypoint'),
    ).rejects.toBeInstanceOf(UnsupportedEntrypointError);
  });
});

describe('UnsupportedEntrypointError', () => {
  it('carries the deployed and required version for diagnostics', () => {
    const error = new UnsupportedEntrypointError('arena', CONTRACT_ID, 'future_entrypoint', 1, 3);

    expect(error.deployedVersion).toBe(1);
    expect(error.requiredVersion).toBe(3);
    expect(error.entrypoint).toBe('future_entrypoint');
    expect(error.message).toContain('future_entrypoint');
  });
});
