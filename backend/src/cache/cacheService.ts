import type Redis from "ioredis";
import { logger } from "../utils/logger";
import { redis } from "./redisClient";

export const MAX_PIPELINE_COMMANDS = 10_000;
export const REDIS_PIPELINE_MAX_ATTEMPTS = 3;
const REDIS_PIPELINE_RETRY_DELAY_MS = 10;

export type RedisPipeline = ReturnType<Redis["pipeline"]>;
export type RedisPipelineResult = [Error | null, unknown];
export type RedisPipelineCommand = (pipeline: RedisPipeline) => void;

export class RedisPipelineError extends Error {
  readonly operation: string;
  readonly failedIndexes: readonly number[];
  readonly causes: readonly Error[];
  readonly partial: boolean;

  constructor(
    operation: string,
    failedIndexes: readonly number[],
    causes: readonly Error[],
    partial: boolean,
  ) {
    super(`Redis pipeline ${operation} failed`);
    this.name = "RedisPipelineError";
    this.operation = operation;
    this.failedIndexes = failedIndexes;
    this.causes = causes;
    this.partial = partial;
  }
}

const RETRYABLE_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "NR_CLOSED",
  "LOADING",
  "BUSY",
  "MASTERDOWN",
  "CLUSTERDOWN",
  "TRYAGAIN",
  "READONLY",
]);

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Redis pipeline operation failed");
}

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  const normalized = code.toUpperCase();
  return /^[A-Z0-9_:-]{1,32}$/.test(normalized) ? normalized : undefined;
}

function isRetryable(error: Error): boolean {
  const code = errorCode(error);
  return code !== undefined
    ? RETRYABLE_CODES.has(code)
    : /(?:connection|connect|socket|timeout|timed out|closed|closing|loading|busy|try again|clusterdown|masterdown|read only)/i.test(
        error.message,
      );
}

function errorName(error: Error): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(error.name) ? error.name : "RedisError";
}

function allIndices(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function normalizeResult(value: unknown): RedisPipelineResult {
  if (!Array.isArray(value) || value.length === 0) {
    return [new Error("Redis pipeline returned an invalid result"), undefined];
  }
  const [error, result] = value;
  return error === null || error === undefined
    ? [null, result]
    : [toError(error), undefined];
}

function waitBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, REDIS_PIPELINE_RETRY_DELAY_MS * (attempt - 1)),
  );
}

function logPipeline(
  level: "info" | "warn" | "error",
  event: string,
  subsystem: string,
  operation: string,
  outcome: "success" | "retry" | "failure",
  itemCount: number,
  attempt: number,
  startedAt: number,
  error?: Error,
): void {
  const fields: Record<string, unknown> = {
    event,
    subsystem,
    operation,
    outcome,
    itemCount,
    attempt,
    latencyMs: Date.now() - startedAt,
  };
  if (error) {
    fields.errorName = errorName(error);
    const code = errorCode(error);
    if (code) fields.errorCode = code;
  }
  logger[level](fields, "Redis pipeline operation");
}

export function rejectPipelineInput(
  subsystem: string,
  operation: string,
  reason: string,
  kind: "type" | "range" = "type",
): never {
  logger.warn(
    { event: "redis_pipeline_rejected", subsystem, operation, reason },
    "Redis pipeline input rejected",
  );
  if (kind === "range") throw new RangeError(`Invalid ${operation} input`);
  throw new TypeError(`Invalid ${operation} input`);
}

export function validatePipelineCommandCount(
  commandCount: number,
  operation: string,
  subsystem = "redis",
): void {
  if (!Number.isSafeInteger(commandCount) || commandCount < 0) {
    rejectPipelineInput(subsystem, operation, "command_count", "range");
  }
  if (commandCount > MAX_PIPELINE_COMMANDS) {
    rejectPipelineInput(subsystem, operation, "maximum_size", "range");
  }
}

function requireString(value: unknown, operation: string, subsystem: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    rejectPipelineInput(subsystem, operation, "key");
  }
  return value;
}

export function validatePipelineKeys(
  keys: unknown,
  operation: string,
  subsystem = "cache",
): string[] {
  if (!Array.isArray(keys)) {
    rejectPipelineInput(subsystem, operation, "keys");
  }
  const values = keys as unknown[];
  validatePipelineCommandCount(values.length, operation, subsystem);
  return values.map((key) => requireString(key, operation, subsystem));
}

export function validatePipelineTtl(
  ttlSeconds: unknown,
  operation: string,
  subsystem = "cache",
): number {
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0
  ) {
    rejectPipelineInput(subsystem, operation, "ttl");
  }
  return ttlSeconds;
}

export async function executeRedisPipeline(
  client: Redis,
  commands: readonly RedisPipelineCommand[],
  operation: string,
  subsystem: string,
): Promise<RedisPipelineResult[]> {
  validatePipelineCommandCount(commands.length, operation, subsystem);
  const operationStartedAt = Date.now();
  if (commands.length === 0) {
    logPipeline(
      "info",
      "redis_pipeline_success",
      subsystem,
      operation,
      "success",
      0,
      0,
      operationStartedAt,
    );
    return [];
  }

  const results: RedisPipelineResult[] = [];
  let pendingIndexes = allIndices(commands.length);

  for (let attempt = 1; attempt <= REDIS_PIPELINE_MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const pipeline = client.pipeline();
      pendingIndexes.forEach((index) => {
        const command = commands[index];
        if (!command) throw new Error("Redis pipeline index is invalid");
        command(pipeline);
      });
      const rawResults = await pipeline.exec();
      if (!Array.isArray(rawResults) || rawResults.length !== pendingIndexes.length) {
        throw new Error("Redis pipeline returned an incomplete result");
      }
      rawResults.forEach((result, position) => {
        const index = pendingIndexes[position];
        if (index === undefined) throw new Error("Redis pipeline index is invalid");
        results[index] = normalizeResult(result);
      });

      const failures = allIndices(commands.length).flatMap((index) => {
        const error = results[index]?.[0];
        return error ? [{ index, error }] : [];
      });
      if (failures.length === 0) {
        logPipeline(
          "info",
          "redis_pipeline_success",
          subsystem,
          operation,
          "success",
          commands.length,
          attempt,
          attemptStartedAt,
        );
        return results;
      }

      const failedIndexes = failures.map(({ index }) => index);
      const causes = failures.map(({ error }) => error);
      if (attempt < REDIS_PIPELINE_MAX_ATTEMPTS && causes.every(isRetryable)) {
        pendingIndexes = failedIndexes;
        logPipeline(
          "warn",
          "redis_pipeline_retry",
          subsystem,
          operation,
          "retry",
          commands.length,
          attempt,
          attemptStartedAt,
          causes[0],
        );
        await waitBeforeRetry(attempt);
        continue;
      }

      throw new RedisPipelineError(
        operation,
        failedIndexes,
        causes,
        results.some((result, index) => result && !failedIndexes.includes(index)),
      );
    } catch (error) {
      if (error instanceof RedisPipelineError) {
        logPipeline(
          "error",
          "redis_pipeline_failure",
          subsystem,
          operation,
          "failure",
          commands.length,
          attempt,
          attemptStartedAt,
          error.causes[0],
        );
        throw error;
      }

      const normalized = toError(error);
      if (attempt < REDIS_PIPELINE_MAX_ATTEMPTS && isRetryable(normalized)) {
        logPipeline(
          "warn",
          "redis_pipeline_retry",
          subsystem,
          operation,
          "retry",
          commands.length,
          attempt,
          attemptStartedAt,
          normalized,
        );
        await waitBeforeRetry(attempt);
        continue;
      }

      const pipelineError = new RedisPipelineError(
        operation,
        pendingIndexes,
        [normalized],
        results.some(Boolean),
      );
      logPipeline(
        "error",
        "redis_pipeline_failure",
        subsystem,
        operation,
        "failure",
        commands.length,
        attempt,
        attemptStartedAt,
        normalized,
      );
      throw pipelineError;
    }
  }

  throw new RedisPipelineError(
    operation,
    pendingIndexes,
    [new Error("Redis pipeline retry limit exceeded")],
    results.some(Boolean),
  );
}

export interface CacheSetEntry {
  key: string;
  value: unknown;
  ttlSeconds: number;
}

interface NormalizedCacheSetEntry {
  key: string;
  serialized: string;
  ttlSeconds: number;
}

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  getMany<T>(keys: readonly string[]): Promise<Array<T | null>>;
  setMany(entries: readonly CacheSetEntry[]): Promise<void>;
  delMany(keys: readonly string[]): Promise<void>;
  delByPattern(pattern: string): Promise<void>;
}

function serialize(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    rejectPipelineInput("cache", "cache.set_many", "serialization");
  }
  if (serialized === undefined) {
    rejectPipelineInput("cache", "cache.set_many", "serialization");
  }
  return serialized;
}

function normalizeSetEntries(entries: unknown): NormalizedCacheSetEntry[] {
  if (!Array.isArray(entries)) {
    rejectPipelineInput("cache", "cache.set_many", "entries");
  }
  const values = entries as unknown[];
  validatePipelineCommandCount(values.length, "cache.set_many", "cache");
  const byKey = new Map<string, NormalizedCacheSetEntry>();
  values.forEach((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rejectPipelineInput("cache", "cache.set_many", "entry");
    }
    const candidate = entry as Partial<CacheSetEntry>;
    const key = requireString(candidate.key, "cache.set_many", "cache");
    const ttlSeconds = validatePipelineTtl(
      candidate.ttlSeconds,
      "cache.set_many",
      "cache",
    );
    const serialized = serialize(candidate.value);
    const previous = byKey.get(key);
    if (
      previous &&
      (previous.serialized !== serialized || previous.ttlSeconds !== ttlSeconds)
    ) {
      rejectPipelineInput("cache", "cache.set_many", "duplicate_key");
    }
    if (!previous) byKey.set(key, { key, serialized, ttlSeconds });
  });
  return [...byKey.values()];
}

function parseResults<T>(results: RedisPipelineResult[]): Array<T | null> {
  return results.map((result, index) => {
    if (result[0]) throw new Error("Cache pipeline returned an invalid result");
    const value = result[1];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
      throw new Error("Cache pipeline returned an invalid value");
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error(`Cache pipeline result ${index} is invalid JSON`);
    }
  });
}

async function deleteKeys(
  client: Redis,
  keys: readonly string[],
  operation: string,
): Promise<void> {
  const uniqueKeys = [...new Set(validatePipelineKeys(keys, operation))];
  await executeRedisPipeline(
    client,
    uniqueKeys.map((key) => (pipeline) => {
      pipeline.del(key);
    }),
    operation,
    "cache",
  );
}

export function createCache(client: Redis = redis): CacheService {
  return {
    async get<T>(key: string): Promise<T | null> {
      const data = await client.get(requireString(key, "cache.get", "cache"));
      return data ? (JSON.parse(data) as T) : null;
    },

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      await client.set(
        requireString(key, "cache.set", "cache"),
        serialize(value),
        "EX",
        validatePipelineTtl(ttlSeconds, "cache.set", "cache"),
      );
    },

    async del(key: string): Promise<void> {
      await client.del(requireString(key, "cache.del", "cache"));
    },

    async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
      const validatedKeys = validatePipelineKeys(keys, "cache.get_many");
      const results = await executeRedisPipeline(
        client,
        validatedKeys.map((key) => (pipeline) => {
          pipeline.get(key);
        }),
        "cache.get_many",
        "cache",
      );
      return parseResults<T>(results);
    },

    async setMany(entries: readonly CacheSetEntry[]): Promise<void> {
      const normalized = normalizeSetEntries(entries);
      await executeRedisPipeline(
        client,
        normalized.map((entry) => (pipeline) => {
          pipeline.set(entry.key, entry.serialized, "EX", entry.ttlSeconds);
        }),
        "cache.set_many",
        "cache",
      );
    },

    async delMany(keys: readonly string[]): Promise<void> {
      await deleteKeys(client, keys, "cache.del_many");
    },

    async delByPattern(pattern: string): Promise<void> {
      const validatedPattern = requireString(
        pattern,
        "cache.del_by_pattern",
        "cache",
      );
      let cursor = "0";
      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          "MATCH",
          validatedPattern,
          "COUNT",
          100,
        );
        if (typeof nextCursor !== "string" || !Array.isArray(keys)) {
          rejectPipelineInput("cache", "cache.del_by_pattern", "scan_result");
        }
        await deleteKeys(client, keys, "cache.del_by_pattern");
        cursor = nextCursor;
      } while (cursor !== "0");
    },
  };
}

export const createCacheService = createCache;
export const cache = createCache(redis);

export const cacheKeys = {
  oracleYield: () => "oracle:yield",
  arenaStats: (arenaId: string) => `arena:stats:${arenaId}`,
  leaderboard: () => "leaderboard",
  arenaOnChainSnapshot: (arenaId: string) => `arena:onchain-snapshot:${arenaId}`,
};

export const cacheTTL = {
  ORACLE_YIELD: 60,
  ARENA_STATS: 15,
  ARENA_ROUNDS: 10,
  LEADERBOARD: 30,
  ARENA_ONCHAIN_SNAPSHOT: 60 * 60 * 24,
} as const;

export async function invalidateArenaStats(arenaId: string): Promise<void> {
  await cache.del(cacheKeys.arenaStats(arenaId));
}
