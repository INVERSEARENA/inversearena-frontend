import { logger } from "./logger";

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold?: number;
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
  private readonly windowStart: number;
  private readonly options: Required<CircuitBreakerOptions>;
  private readonly listeners: Map<string, Array<() => void>> = new Map();
  private readonly activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      volumeThreshold: 5,
      ...options,
    };
    this.windowStart = Date.now();
  }

  async fire<T>(action: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.shouldAttemptReset()) {
        this.transitionTo("half-open");
      } else {
        throw new CircuitOpenError("Soroban RPC circuit is OPEN — request rejected");
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error(`Soroban RPC call timed out after ${this.options.timeout}ms`)),
        this.options.timeout,
      );
      this.activeTimeouts.add(timerId);
    });

    try {
      const result = await Promise.race([action(), timeoutPromise]);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (timerId) {
        clearTimeout(timerId);
        this.activeTimeouts.delete(timerId);
      }
    }
  }

  getStats(): CircuitBreakerStats {
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

  destroy(): void {
    for (const timerId of this.activeTimeouts) {
      clearTimeout(timerId);
    }
    this.activeTimeouts.clear();
    this.listeners.clear();
  }

  private onSuccess(): void {
    this.successes++;
    if (this.state === "half-open") {
      this.transitionTo("closed");
      this.reset();
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    const total = this.failures + this.successes;
    if (total < this.options.volumeThreshold) return;

    const errorRate = (this.failures / total) * 100;
    if (errorRate >= this.options.errorThresholdPercentage) {
      this.transitionTo("open");
    }
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
  }
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
  if (_sorobanBreaker) {
    _sorobanBreaker.destroy();
    _sorobanBreaker = null;
  }
}
