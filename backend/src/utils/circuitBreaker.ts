import { logger } from "./logger";

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold?: number;
  /** Sliding window over which success/failure counts are evaluated. */
  rollingWindowMs?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private successTimes: number[] = [];
  private failureTimes: number[] = [];
  private readonly options: Required<CircuitBreakerOptions>;
  private readonly listeners: Map<string, Array<() => void>> = new Map();

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      volumeThreshold: 5,
      rollingWindowMs: 60_000,
      ...options,
    };
  }

  async fire<T>(action: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.shouldAttemptReset()) {
        this.transitionTo("half-open");
      } else {
        throw new CircuitOpenError("Soroban RPC circuit is OPEN — request rejected");
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Soroban RPC call timed out after ${this.options.timeout}ms`)),
        this.options.timeout,
      );
    });

    try {
      const result = await Promise.race([action(), timeoutPromise]);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  getStats(): CircuitBreakerStats {
    this.pruneWindow(Date.now());
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
    };
  }

  on(event: "open" | "close" | "halfOpen", listener: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
  }

  private onSuccess(): void {
    const now = Date.now();
    this.successTimes.push(now);
    this.pruneWindow(now);
    if (this.state === "half-open") {
      this.transitionTo("closed");
      this.reset();
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.failureTimes.push(now);
    this.lastFailureTime = now;
    this.pruneWindow(now);

    const total = this.failures + this.successes;
    if (total < this.options.volumeThreshold) return;

    const errorRate = (this.failures / total) * 100;
    if (errorRate >= this.options.errorThresholdPercentage) {
      this.transitionTo("open");
    }
  }

  /** Drop samples older than the rolling window so historical successes cannot dilute a real outage. */
  private pruneWindow(now: number): void {
    const cutoff = now - this.options.rollingWindowMs;
    this.successTimes = dropOlderThan(this.successTimes, cutoff);
    this.failureTimes = dropOlderThan(this.failureTimes, cutoff);
    this.successes = this.successTimes.length;
    this.failures = this.failureTimes.length;
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return false;
    return Date.now() - this.lastFailureTime >= this.options.resetTimeout;
  }

  private transitionTo(next: CircuitState): void {
    if (this.state === next) return;
    this.state = next;

    const eventMap: Record<CircuitState, string> = {
      open: "open",
      closed: "close",
      "half-open": "halfOpen",
    };

    const eventName = eventMap[next];
    const handlers = this.listeners.get(eventName) ?? [];
    for (const handler of handlers) handler();
  }

  private reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.successTimes = [];
    this.failureTimes = [];
  }
}

function dropOlderThan(times: number[], cutoff: number): number[] {
  const firstKept = times.findIndex((t) => t > cutoff);
  if (firstKept === -1) return [];
  return firstKept === 0 ? times : times.slice(firstKept);
}

export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  // Picked up by the API error handler so request-path callers get an
  // immediate 503 while the circuit is open, instead of a generic 500 (#1126).
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

let _sorobanBreaker: CircuitBreaker | null = null;

export function getSorobanBreaker(): CircuitBreaker {
  if (!_sorobanBreaker) {
    _sorobanBreaker = new CircuitBreaker({
      timeout: 10_000,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      volumeThreshold: 5,
    });

    _sorobanBreaker.on("open", () => {
      logger.warn({ subsystem: "circuit-breaker" }, "Soroban RPC circuit open");
      try {
        const { sorobanCircuitBreakerState, sorobanCircuitTransitionsTotal } =
          require("./metrics") as typeof import("./metrics");
        sorobanCircuitBreakerState.set(2);
        sorobanCircuitTransitionsTotal.inc({ to_state: "open" });
      } catch { /* metrics not available in test environments */ }
    });
    _sorobanBreaker.on("halfOpen", () => {
      logger.info({ subsystem: "circuit-breaker" }, "Soroban RPC circuit half-open");
      try {
        const { sorobanCircuitBreakerState, sorobanCircuitTransitionsTotal } =
          require("./metrics") as typeof import("./metrics");
        sorobanCircuitBreakerState.set(1);
        sorobanCircuitTransitionsTotal.inc({ to_state: "half-open" });
      } catch { /* metrics not available in test environments */ }
    });
    _sorobanBreaker.on("close", () => {
      logger.info({ subsystem: "circuit-breaker" }, "Soroban RPC circuit closed");
      try {
        const { sorobanCircuitBreakerState, sorobanCircuitTransitionsTotal } =
          require("./metrics") as typeof import("./metrics");
        sorobanCircuitBreakerState.set(0);
        sorobanCircuitTransitionsTotal.inc({ to_state: "closed" });
      } catch { /* metrics not available in test environments */ }
    });
  }
  return _sorobanBreaker;
}

export function resetSorobanBreakerForTest(): void {
  _sorobanBreaker = null;
}
