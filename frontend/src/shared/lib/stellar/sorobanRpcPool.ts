import { rpc } from "@stellar/stellar-sdk";

export interface RpcProviderConfig {
  url: string;
  weight?: number;
}

export interface RpcPoolOptions {
  urls: string[];
  maxLedgerLag?: number;
  requestTimeoutMs?: number;
  rollingWindowMs?: number;
  stickyTtlMs?: number;
  onMetricsUpdate?: (stats: ProviderHealthStats[]) => void;
  onFailover?: (fromUrl: string, toUrl: string, reason: string) => void;
}

export interface ProviderHealthStats {
  url: string;
  latencyMs: number;
  errorRate: number;
  latestLedger: number;
  ledgerLag: number;
  healthScore: number;
  isLagging: boolean;
  isHealthy: boolean;
  consecutiveErrors: number;
}

export class ProviderCircuitBreaker {
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

  constructor(
    private readonly failureThreshold = 3,
    private readonly resetTimeoutMs = 15_000,
  ) {}

  isOpen(): boolean {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.successes++;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  getState(): "CLOSED" | "OPEN" | "HALF_OPEN" {
    return this.state;
  }
}

interface ProviderNode {
  url: string;
  server: rpc.Server;
  breaker: ProviderCircuitBreaker;
  latencies: number[];
  errors: number;
  successes: number;
  latestLedger: number;
  consecutiveErrors: number;
  lastUpdated: number;
}

export class SorobanRpcPool {
  private providers: ProviderNode[];
  private maxLedgerLag: number;
  private requestTimeoutMs: number;
  private stickyMap = new Map<string, { url: string; expiresAt: number }>();
  private stickyTtlMs: number;
  private onMetricsUpdate?: (stats: ProviderHealthStats[]) => void;
  private onFailover?: (fromUrl: string, toUrl: string, reason: string) => void;

  constructor(options: RpcPoolOptions) {
    if (!options.urls || options.urls.length === 0) {
      throw new Error("SorobanRpcPool requires at least one RPC URL");
    }
    this.maxLedgerLag = options.maxLedgerLag ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.stickyTtlMs = options.stickyTtlMs ?? 300_000; // 5 minutes
    this.onMetricsUpdate = options.onMetricsUpdate;
    this.onFailover = options.onFailover;

    const uniqueUrls = [...new Set(options.urls.map((u) => u.trim().replace(/\/+$/, "")))];
    this.providers = uniqueUrls.map((url) => ({
      url,
      server: new rpc.Server(url, { allowHttp: url.startsWith("http://") }),
      breaker: new ProviderCircuitBreaker(),
      latencies: [],
      errors: 0,
      successes: 0,
      latestLedger: 0,
      consecutiveErrors: 0,
      lastUpdated: Date.now(),
    }));
  }

  getProviders(): string[] {
    return this.providers.map((p) => p.url);
  }

  /**
   * Calculate health score for each provider:
   * Score = (1 - error_rate) * latency_score * lag_penalty (0 to 100)
   */
  getHealthStats(): ProviderHealthStats[] {
    const highestLedger = Math.max(0, ...this.providers.map((p) => p.latestLedger));

    return this.providers.map((p) => {
      const totalCalls = p.successes + p.errors;
      const errorRate = totalCalls > 0 ? p.errors / totalCalls : 0;
      const avgLatency =
        p.latencies.length > 0
          ? p.latencies.reduce((a, b) => a + b, 0) / p.latencies.length
          : 50;

      const ledgerLag = highestLedger > 0 && p.latestLedger > 0 ? Math.max(0, highestLedger - p.latestLedger) : 0;
      const isLagging = highestLedger > 0 && ledgerLag > this.maxLedgerLag;
      const isCircuitOpen = p.breaker.isOpen();

      let healthScore = 100;
      if (isCircuitOpen) {
        healthScore = 0;
      } else if (isLagging) {
        healthScore = Math.max(5, 50 - ledgerLag * 5);
      } else {
        const latencyFactor = Math.max(0.1, 500 / Math.max(500, avgLatency));
        const errorFactor = Math.max(0, 1 - errorRate);
        const lagPenalty = Math.max(0, 1 - ledgerLag / (this.maxLedgerLag + 1));
        healthScore = Math.round(100 * errorFactor * latencyFactor * lagPenalty);
      }

      const isHealthy = !isCircuitOpen && !isLagging && healthScore > 20;

      return {
        url: p.url,
        latencyMs: Math.round(avgLatency),
        errorRate: Math.round(errorRate * 100) / 100,
        latestLedger: p.latestLedger,
        ledgerLag,
        healthScore,
        isLagging,
        isHealthy,
        consecutiveErrors: p.consecutiveErrors,
      };
    });
  }

  private notifyMetrics(): void {
    if (this.onMetricsUpdate) {
      try {
        this.onMetricsUpdate(this.getHealthStats());
      } catch {
        // Suppress telemetry callback errors
      }
    }
  }

  /**
   * Sort providers by health score in descending order.
   * If excludeLagging is true, excludes providers lagging by > maxLedgerLag.
   */
  getRankedProviders(excludeLagging = true): ProviderNode[] {
    const stats = this.getHealthStats();
    const statsMap = new Map(stats.map((s) => [s.url, s]));

    return [...this.providers]
      .filter((p) => {
        const s = statsMap.get(p.url);
        if (!s) return false;
        if (p.breaker.isOpen()) return false;
        if (excludeLagging && s.isLagging) return false;
        return true;
      })
      .sort((a, b) => {
        const sa = statsMap.get(a.url)?.healthScore ?? 0;
        const sb = statsMap.get(b.url)?.healthScore ?? 0;
        return sb - sa;
      });
  }

  /**
   * Execute a read operation against the healthiest provider, with automatic failover.
   */
  async executeRead<T>(
    operationName: string,
    action: (server: rpc.Server, url: string) => Promise<T>,
  ): Promise<T> {
    let ranked = this.getRankedProviders(true);
    if (ranked.length === 0) {
      // If all healthy non-lagging providers are exhausted, fallback to any non-broken provider
      ranked = this.getRankedProviders(false);
    }
    if (ranked.length === 0) {
      ranked = this.providers; // Last ditch fallback
    }

    let lastError: unknown;
    for (let i = 0; i < ranked.length; i++) {
      const node = ranked[i];
      const start = Date.now();
      try {
        const result = await this.withTimeout(action(node.server, node.url), this.requestTimeoutMs);
        const elapsed = Date.now() - start;
        this.recordSuccess(node, elapsed);
        return result;
      } catch (err) {
        lastError = err;
        this.recordFailure(node);
        const nextNode = ranked[i + 1];
        if (nextNode) {
          this.onFailover?.(node.url, nextNode.url, `${operationName} error: ${err}`);
        }
      }
    }

    throw lastError;
  }

  /**
   * Execute sendTransaction: route to the best healthy provider and record
   * a sticky mapping (hash -> providerUrl) for transaction polling stickiness.
   */
  async sendTransaction(
    transaction: Parameters<rpc.Server["sendTransaction"]>[0],
  ): Promise<Awaited<ReturnType<rpc.Server["sendTransaction"]>>> {
    const ranked = this.getRankedProviders(true);
    const primary = ranked[0] ?? this.providers[0];

    const start = Date.now();
    try {
      const response = await this.withTimeout(
        primary.server.sendTransaction(transaction),
        this.requestTimeoutMs,
      );
      this.recordSuccess(primary, Date.now() - start);

      if (response && "hash" in response && typeof response.hash === "string") {
        this.stickyMap.set(response.hash, {
          url: primary.url,
          expiresAt: Date.now() + this.stickyTtlMs,
        });
      }

      return response;
    } catch (err) {
      this.recordFailure(primary);
      // Failover to secondary provider on submission failure if multiple exist
      const secondary = ranked[1];
      if (secondary) {
        this.onFailover?.(primary.url, secondary.url, `sendTransaction failed: ${err}`);
        const secStart = Date.now();
        const response = await this.withTimeout(
          secondary.server.sendTransaction(transaction),
          this.requestTimeoutMs,
        );
        this.recordSuccess(secondary, Date.now() - secStart);
        if (response && "hash" in response && typeof response.hash === "string") {
          this.stickyMap.set(response.hash, {
            url: secondary.url,
            expiresAt: Date.now() + this.stickyTtlMs,
          });
        }
        return response;
      }
      throw err;
    }
  }

  /**
   * Get transaction: sticky to the provider that submitted the transaction,
   * falling back automatically to other healthy providers if that provider is unresponsive.
   */
  async getTransaction(hash: string): Promise<Awaited<ReturnType<rpc.Server["getTransaction"]>>> {
    this.cleanExpiredStickyEntries();

    const sticky = this.stickyMap.get(hash);
    let preferredNode = sticky ? this.providers.find((p) => p.url === sticky.url) : undefined;

    if (preferredNode && preferredNode.breaker.isOpen()) {
      preferredNode = undefined;
    }

    if (preferredNode) {
      const start = Date.now();
      try {
        const res = await this.withTimeout(
          preferredNode.server.getTransaction(hash),
          this.requestTimeoutMs,
        );
        this.recordSuccess(preferredNode, Date.now() - start);
        return res;
      } catch (err) {
        this.recordFailure(preferredNode);
        // Fallback to read failover loop
      }
    }

    // Failover fallback across pool
    return this.executeRead(`getTransaction(${hash})`, (server) => server.getTransaction(hash));
  }

  /**
   * Update known latest ledger across all providers to detect lagging nodes.
   */
  async updateLedgerLag(): Promise<void> {
    await Promise.allSettled(
      this.providers.map(async (node) => {
        try {
          const start = Date.now();
          const health = await this.withTimeout(node.server.getLatestLedger(), 5000);
          this.recordSuccess(node, Date.now() - start);
          if (health && typeof health.sequence === "number") {
            node.latestLedger = health.sequence;
          }
        } catch {
          this.recordFailure(node);
        }
      }),
    );
    this.notifyMetrics();
  }

  // Delegated read operations
  async simulateTransaction(
    tx: Parameters<rpc.Server["simulateTransaction"]>[0],
  ): Promise<Awaited<ReturnType<rpc.Server["simulateTransaction"]>>> {
    return this.executeRead("simulateTransaction", (server) => server.simulateTransaction(tx));
  }

  async getLedgerEntries(
    ...keys: Parameters<rpc.Server["getLedgerEntries"]>
  ): Promise<Awaited<ReturnType<rpc.Server["getLedgerEntries"]>>> {
    return this.executeRead("getLedgerEntries", (server) => server.getLedgerEntries(...keys));
  }

  async getEvents(
    req: rpc.Api.GetEventsRequest,
  ): Promise<rpc.Api.GetEventsResponse> {
    return this.executeRead("getEvents", (server) => server.getEvents(req));
  }

  async getLatestLedger(): Promise<number> {
    return this.executeRead("getLatestLedger", async (server, url) => {
      const res = await server.getLatestLedger();
      const node = this.providers.find((p) => p.url === url);
      if (node && res.sequence) {
        node.latestLedger = res.sequence;
      }
      return res.sequence;
    });
  }

  async getLatestLedgerIdentity(): Promise<{ sequence: number; id: string }> {
    return this.executeRead("getLatestLedgerIdentity", async (server, url) => {
      const res = await server.getLatestLedger();
      const node = this.providers.find((p) => p.url === url);
      if (node && res.sequence) {
        node.latestLedger = res.sequence;
      }
      return { sequence: res.sequence, id: res.id };
    });
  }

  private recordSuccess(node: ProviderNode, latencyMs: number): void {
    node.latencies.push(latencyMs);
    if (node.latencies.length > 20) node.latencies.shift();
    node.successes++;
    node.consecutiveErrors = 0;
    node.breaker.recordSuccess();
    node.lastUpdated = Date.now();
    this.notifyMetrics();
  }

  private recordFailure(node: ProviderNode): void {
    node.errors++;
    node.consecutiveErrors++;
    node.breaker.recordFailure();
    node.lastUpdated = Date.now();
    this.notifyMetrics();
  }

  private cleanExpiredStickyEntries(): void {
    const now = Date.now();
    for (const [hash, entry] of this.stickyMap.entries()) {
      if (entry.expiresAt < now) {
        this.stickyMap.delete(hash);
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Soroban RPC call timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}
