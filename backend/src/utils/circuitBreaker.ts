type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold?: number;
}

interface CircuitBreakerStats {
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

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Soroban RPC call timed out after ${this.options.timeout}ms`)),
        this.options.timeout,
      ),
    );

    try {
      const result = await Promise.race([action(), timeoutPromise]);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
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
      console.warn("[circuit-breaker] Soroban RPC circuit OPEN — calls will be rejected");
      try {
        const { sorobanCircuitBreakerState, sorobanCircuitTransitionsTotal } =
          require("./metrics") as typeof import("./metrics");
        sorobanCircuitBreakerState.set(2);
        sorobanCircuitTransitionsTotal.inc({ to_state: "open" });
      } catch { /* metrics not available in test environments */ }
    });
    _sorobanBreaker.on("halfOpen", () => {
      console.info("[circuit-breaker] Soroban RPC circuit HALF-OPEN — probing");
      try {
        const { sorobanCircuitBreakerState, sorobanCircuitTransitionsTotal } =
          require("./metrics") as typeof import("./metrics");
        sorobanCircuitBreakerState.set(1);
        sorobanCircuitTransitionsTotal.inc({ to_state: "half-open" });
      } catch { /* metrics not available in test environments */ }
    });
    _sorobanBreaker.on("close", () => {
      console.info("[circuit-breaker] Soroban RPC circuit CLOSED — normal operation");
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
