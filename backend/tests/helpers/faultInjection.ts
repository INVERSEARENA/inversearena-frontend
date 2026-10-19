/**
 * Deterministic fault-injection helpers for RPC, Redis, and queues (#1461).
 *
 * A `FaultInjector` holds an ordered list of `FaultRule`s and decides, per
 * call, whether a wrapped operation should misbehave. Decisions depend only on
 * the per-(target, operation) call counter and the call's key — never on wall
 * clock or randomness — so the same rules against the same call sequence
 * always produce the same faults.
 *
 * Fault kinds (same semantics on every target):
 *  - timeout   — the call rejects with `InjectedTimeoutError` (code ETIMEDOUT)
 *                without reaching the underlying system. No real timers are
 *                armed, so suites stay fast and leak no handles.
 *  - outage    — the call rejects with `InjectedOutageError` (ECONNREFUSED).
 *                Scoped with `key` this models a *partial* outage: only calls
 *                whose key starts with the prefix fail.
 *  - stale     — the call returns the last successful result previously
 *                observed for the same (operation, key) instead of a fresh one.
 *                Rejects with `FaultConfigError` if nothing was observed yet.
 *  - duplicate — the underlying operation is executed twice (duplicate
 *                request / duplicate delivery); the second result is returned.
 *
 * See backend/docs/FAULT_INJECTION.md for the design note.
 */

import type Redis from "ioredis";
import type { xdr } from "@stellar/stellar-sdk";
import type { OnChainRpcServer } from "../../src/services/onChainReader";
import { logger } from "../../src/utils/logger";

export type FaultTarget = "rpc" | "redis" | "queue";
export type FaultKind = "timeout" | "outage" | "stale" | "duplicate";

export interface FaultRule {
  target: FaultTarget;
  kind: FaultKind;
  /** Operation name (RPC method, Redis command, queue job name). Omit or "*" for any. */
  operation?: string;
  /** Key prefix (RPC contract fn, Redis key, queue job id). Omit for any key. */
  key?: string;
  /** 1-based call indices (per target + operation) on which to fire. Omit for every call. */
  onCalls?: readonly number[];
  /** Maximum number of times this rule fires. Omit for unlimited. */
  times?: number;
}

export type FaultOutcome = "success" | "failure";

export interface FaultEvent {
  target: FaultTarget;
  operation: string;
  key: string | null;
  call: number;
  fault: FaultKind | null;
  outcome: FaultOutcome;
  retry: boolean;
  latencyMs: number;
}

export interface FaultStats {
  calls: number;
  success: number;
  failure: number;
  retries: number;
  faults: Record<FaultKind, number>;
  totalLatencyMs: number;
}

export class FaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultConfigError";
  }
}

export class InjectedTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(readonly target: FaultTarget, readonly operation: string) {
    super(`Injected timeout: ${target}.${operation}`);
    this.name = "InjectedTimeoutError";
  }
}

export class InjectedOutageError extends Error {
  readonly code = "ECONNREFUSED";
  constructor(readonly target: FaultTarget, readonly operation: string) {
    super(`Injected outage: ${target}.${operation}`);
    this.name = "InjectedOutageError";
  }
}

const FAULT_KINDS: readonly FaultKind[] = ["timeout", "outage", "stale", "duplicate"];
const FAULT_TARGETS: readonly FaultTarget[] = ["rpc", "redis", "queue"];

function validateRule(rule: FaultRule, index: number): void {
  if (!FAULT_TARGETS.includes(rule.target)) {
    throw new FaultConfigError(`rules[${index}]: unknown target "${String(rule.target)}"`);
  }
  if (!FAULT_KINDS.includes(rule.kind)) {
    throw new FaultConfigError(`rules[${index}]: unknown kind "${String(rule.kind)}"`);
  }
  if (rule.times !== undefined && (!Number.isInteger(rule.times) || rule.times < 1)) {
    throw new FaultConfigError(`rules[${index}]: times must be a positive integer`);
  }
  if (rule.onCalls !== undefined) {
    for (const call of rule.onCalls) {
      if (!Number.isInteger(call) || call < 1) {
        throw new FaultConfigError(`rules[${index}]: onCalls entries must be positive integers`);
      }
    }
  }
}

export interface FaultInjectorOptions {
  /** Monotonic clock used for latency accounting. Defaults to `performance.now`. */
  now?: () => number;
}

export class FaultInjector {
  private readonly rules: FaultRule[];
  private readonly fired: number[];
  private readonly counters = new Map<string, number>();
  private readonly lastResults = new Map<string, unknown>();
  private readonly now: () => number;
  readonly events: FaultEvent[] = [];

  constructor(rules: readonly FaultRule[] = [], options: FaultInjectorOptions = {}) {
    rules.forEach(validateRule);
    this.rules = [...rules];
    this.fired = this.rules.map(() => 0);
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * Run `execute` under the fault plan. `execute` performs the real
   * operation; it may be called zero (timeout/outage/stale), one, or two
   * (duplicate) times.
   */
  async run<T>(
    target: FaultTarget,
    operation: string,
    key: string | null,
    execute: () => Promise<T>,
    retry = false,
  ): Promise<T> {
    const counterKey = `${target}:${operation}`;
    const call = (this.counters.get(counterKey) ?? 0) + 1;
    this.counters.set(counterKey, call);
    const fault = this.decide(target, operation, key, call);
    const resultKey = `${target}:${operation}:${key ?? ""}`;
    const started = this.now();

    const finish = (outcome: FaultOutcome): void => {
      const event: FaultEvent = {
        target,
        operation,
        key,
        call,
        fault,
        outcome,
        retry,
        latencyMs: Math.max(0, this.now() - started),
      };
      this.events.push(event);
      logger.debug({ subsystem: "fault-injection", ...event }, "fault injection call");
    };

    try {
      let result: T;
      switch (fault) {
        case "timeout":
          throw new InjectedTimeoutError(target, operation);
        case "outage":
          throw new InjectedOutageError(target, operation);
        case "stale":
          if (!this.lastResults.has(resultKey)) {
            throw new FaultConfigError(
              `stale fault on ${target}.${operation} (key=${key ?? "*"}) has no prior result to replay`,
            );
          }
          result = this.lastResults.get(resultKey) as T;
          break;
        case "duplicate":
          await execute();
          result = await execute();
          this.lastResults.set(resultKey, result);
          break;
        default:
          result = await execute();
          this.lastResults.set(resultKey, result);
      }
      finish("success");
      return result;
    } catch (error) {
      finish("failure");
      throw error;
    }
  }

  stats(target?: FaultTarget): FaultStats {
    const stats: FaultStats = {
      calls: 0,
      success: 0,
      failure: 0,
      retries: 0,
      faults: { timeout: 0, outage: 0, stale: 0, duplicate: 0 },
      totalLatencyMs: 0,
    };
    for (const event of this.events) {
      if (target !== undefined && event.target !== target) continue;
      stats.calls += 1;
      stats[event.outcome] += 1;
      if (event.retry) stats.retries += 1;
      if (event.fault) stats.faults[event.fault] += 1;
      stats.totalLatencyMs += event.latencyMs;
    }
    return stats;
  }

  private decide(
    target: FaultTarget,
    operation: string,
    key: string | null,
    call: number,
  ): FaultKind | null {
    for (let i = 0; i < this.rules.length; i += 1) {
      const rule = this.rules[i]!;
      if (rule.target !== target) continue;
      if (rule.operation !== undefined && rule.operation !== "*" && rule.operation !== operation) {
        continue;
      }
      if (rule.key !== undefined && (key === null || !key.startsWith(rule.key))) continue;
      if (rule.onCalls !== undefined && !rule.onCalls.includes(call)) continue;
      if (rule.times !== undefined && this.fired[i]! >= rule.times) continue;
      this.fired[i]! += 1;
      return rule.kind;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function contractFunctionName(tx: unknown): string | null {
  try {
    const op = (tx as { operations: Array<{ func?: xdr.HostFunction }> }).operations[0];
    return op?.func?.invokeContract().functionName().toString() ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap a Soroban RPC server (real or stub) so it can be installed with
 * `onChainReader.setRpcServerForTest`. Operations are `getAccount` (key =
 * account id) and `simulateTransaction` (key = invoked contract function).
 */
export function createFaultyRpcServer(
  base: OnChainRpcServer,
  injector: FaultInjector,
): OnChainRpcServer {
  return {
    getAccount: (address) =>
      injector.run("rpc", "getAccount", address, () => base.getAccount(address)),
    simulateTransaction: (tx, ...rest) =>
      injector.run("rpc", "simulateTransaction", contractFunctionName(tx), () =>
        base.simulateTransaction(tx, ...rest),
      ),
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Client methods that are lifecycle/event plumbing rather than commands;
 * these pass through untouched. Pipelines/multi are also passed through —
 * inject faults on the individual commands instead.
 */
const REDIS_PASSTHROUGH = new Set([
  "on",
  "once",
  "off",
  "emit",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "listeners",
  "connect",
  "disconnect",
  "quit",
  "duplicate",
  "pipeline",
  "multi",
  "defineCommand",
]);

/**
 * Wrap an ioredis client (real or in-memory double) so every command goes
 * through the fault plan. Operation = command name, key = first string arg.
 */
export function createFaultyRedis<T extends object = Redis>(base: T, injector: FaultInjector): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || REDIS_PASSTHROUGH.has(prop)) {
        return value;
      }
      return (...args: unknown[]) => {
        const key = typeof args[0] === "string" ? args[0] : null;
        return injector.run("redis", prop, key, async () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface FaultQueueJob<D> {
  id: string;
  name: string;
  data: D;
  attemptsMade: number;
}

export type FaultQueueProcessor<D, R> = (job: FaultQueueJob<D>) => Promise<R>;

export interface FaultQueueDeliveryOptions {
  /** Total delivery attempts per job, mirroring BullMQ `attempts`. Default 1. */
  attempts?: number;
}

export interface FaultQueueDeliveryResult<R> {
  status: "completed" | "failed";
  attemptsMade: number;
  result?: R;
  error?: unknown;
}

/**
 * In-process stand-in for a BullMQ worker loop: delivers jobs to `processor`
 * through the fault plan and retries up to `attempts` times. Operation = job
 * name, key = job id. `duplicate` invokes the processor twice for the same
 * delivery, so processors can be checked for idempotency.
 */
export class FaultQueueDelivery<D, R> {
  private readonly attempts: number;

  constructor(
    private readonly processor: FaultQueueProcessor<D, R>,
    private readonly injector: FaultInjector,
    options: FaultQueueDeliveryOptions = {},
  ) {
    const attempts = options.attempts ?? 1;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new FaultConfigError("attempts must be a positive integer");
    }
    this.attempts = attempts;
  }

  async deliver(job: { id: string; name: string; data: D }): Promise<FaultQueueDeliveryResult<R>> {
    if (typeof job.id !== "string" || job.id.length === 0) {
      throw new FaultConfigError("job.id must be a non-empty string");
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const delivered: FaultQueueJob<D> = { ...job, attemptsMade: attempt };
      try {
        const result = await this.injector.run(
          "queue",
          job.name,
          job.id,
          () => this.processor(delivered),
          attempt > 0,
        );
        return { status: "completed", attemptsMade: attempt + 1, result };
      } catch (error) {
        if (error instanceof FaultConfigError) throw error;
        lastError = error;
      }
    }
    return { status: "failed", attemptsMade: this.attempts, error: lastError };
  }
}
