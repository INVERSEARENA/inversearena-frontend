/**
 * Unit tests for CircuitBreaker (#1279)
 *
 * Verifies the setTimeout leak fix: the timeout handle must be cleared
 * when action() resolves before the deadline, so Jest's detectOpenHandles
 * does not flag a dangling timer.
 */

import { CircuitBreaker, CircuitOpenError, resetSorobanBreakerForTest } from '../src/utils/circuitBreaker';

beforeEach(() => {
  resetSorobanBreakerForTest();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CircuitBreaker.fire()', () => {
  it('resolves with the action result when action completes before timeout', async () => {
    const breaker = new CircuitBreaker({ timeout: 1000, errorThresholdPercentage: 50, resetTimeout: 5000 });
    const result = await breaker.fire(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('clears the timeout handle when action resolves before deadline (no dangling timer)', async () => {
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    const breaker = new CircuitBreaker({ timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 10000 });

    await breaker.fire(() => Promise.resolve('done'));

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears the timeout handle when action rejects before deadline', async () => {
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    const breaker = new CircuitBreaker({ timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 10000 });

    await expect(breaker.fire(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('rejects with a timeout error when action exceeds the deadline', async () => {
    const breaker = new CircuitBreaker({ timeout: 100, errorThresholdPercentage: 50, resetTimeout: 5000 });

    const slow = new Promise<never>(() => { /* never resolves */ });
    const firePromise = breaker.fire(() => slow);

    jest.advanceTimersByTime(200);

    await expect(firePromise).rejects.toThrow(/timed out after 100ms/);
  });

  it('opens the circuit after enough failures exceed the error threshold', async () => {
    const breaker = new CircuitBreaker({
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 10000,
      volumeThreshold: 2,
    });

    await expect(breaker.fire(() => Promise.reject(new Error('e1')))).rejects.toThrow('e1');
    await expect(breaker.fire(() => Promise.reject(new Error('e2')))).rejects.toThrow('e2');

    expect(breaker.getStats().state).toBe('open');
    await expect(breaker.fire(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('opens after a failure burst even when a large historical success count has aged out of the window (#1345)', async () => {
    const breaker = new CircuitBreaker({
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 10_000,
      volumeThreshold: 5,
      rollingWindowMs: 1000,
    });

    for (let i = 0; i < 100; i++) {
      await breaker.fire(() => Promise.resolve('ok'));
    }
    expect(breaker.getStats().state).toBe('closed');
    expect(breaker.getStats().successes).toBe(100);

    jest.advanceTimersByTime(1000);

    for (let i = 0; i < 5; i++) {
      await expect(breaker.fire(() => Promise.reject(new Error('outage')))).rejects.toThrow('outage');
    }

    expect(breaker.getStats().state).toBe('open');
    expect(breaker.getStats().successes).toBe(0);
    await expect(breaker.fire(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('transitions to half-open after resetTimeout and closes on success', async () => {
    const breaker = new CircuitBreaker({
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 1000,
      volumeThreshold: 2,
    });

    await expect(breaker.fire(() => Promise.reject(new Error('e1')))).rejects.toThrow();
    await expect(breaker.fire(() => Promise.reject(new Error('e2')))).rejects.toThrow();
    expect(breaker.getStats().state).toBe('open');

    jest.advanceTimersByTime(1500);

    const result = await breaker.fire(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(breaker.getStats().state).toBe('closed');
  });
});
