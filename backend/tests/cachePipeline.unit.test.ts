import { jest } from "@jest/globals";
import type Redis from "ioredis";
import {
  createCache,
  MAX_PIPELINE_COMMANDS,
  RedisPipelineError,
} from "../src/cache/cacheService";
import { SessionStore } from "../src/cache/sessionStore";
import { logger } from "../src/utils/logger";

type Command = { name: string; args: unknown[] };
type FakePipeline = {
  get: (...args: unknown[]) => FakePipeline;
  set: (...args: unknown[]) => FakePipeline;
  sadd: (...args: unknown[]) => FakePipeline;
  del: (...args: unknown[]) => FakePipeline;
  srem: (...args: unknown[]) => FakePipeline;
  exec: () => Promise<Array<[Error | null, unknown]>>;
};
type ExecBehavior =
  | { kind: "success" }
  | { kind: "reject"; error: Error }
  | { kind: "partial"; index: number; error: Error };

class InstrumentedRedis {
  roundTrips = 0;
  pipelineCalls = 0;
  pipelineExecCalls = 0;
  readonly commands: Command[] = [];
  readonly ttls = new Map<string, number>();
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly behaviors: ExecBehavior[] = [];

  queueBehavior(behavior: ExecBehavior): void {
    this.behaviors.push(behavior);
  }

  private directCall(): void {
    this.roundTrips += 1;
  }

  async get(key: string): Promise<string | null> {
    this.directCall();
    return this.values.get(key) ?? null;
  }

  async set(...args: unknown[]): Promise<"OK"> {
    this.directCall();
    const key = String(args[0]);
    this.values.set(key, String(args[1]));
    if (args[2] === "EX") this.ttls.set(key, Number(args[3]));
    return "OK";
  }

  async sadd(key: string, member: string): Promise<number> {
    this.directCall();
    const members = this.sets.get(key) ?? new Set<string>();
    members.add(member);
    this.sets.set(key, members);
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    this.directCall();
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async srem(key: string, member: string): Promise<number> {
    this.directCall();
    const members = this.sets.get(key);
    if (!members?.delete(member)) return 0;
    return 1;
  }

  async smembers(key: string): Promise<string[]> {
    this.directCall();
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async scan(): Promise<[string, string[]]> {
    this.directCall();
    return ["0", []];
  }

  pipeline() {
    this.pipelineCalls += 1;
    const queued: Command[] = [];
    const pipeline: FakePipeline = {
      get: (...args: unknown[]) => {
        queued.push({ name: "get", args });
        return pipeline;
      },
      set: (...args: unknown[]) => {
        queued.push({ name: "set", args });
        return pipeline;
      },
      sadd: (...args: unknown[]) => {
        queued.push({ name: "sadd", args });
        return pipeline;
      },
      del: (...args: unknown[]) => {
        queued.push({ name: "del", args });
        return pipeline;
      },
      srem: (...args: unknown[]) => {
        queued.push({ name: "srem", args });
        return pipeline;
      },
      exec: async () => {
        this.roundTrips += 1;
        this.pipelineExecCalls += 1;
        const behavior = this.behaviors.shift() ?? { kind: "success" as const };
        if (behavior.kind === "reject") throw behavior.error;
        this.commands.push(...queued);
        return queued.map((command, index) => {
          if (behavior.kind === "partial" && behavior.index === index) {
            return [behavior.error, undefined];
          }
          return [null, this.execute(command)];
        });
      },
    };
    return pipeline;
  }

  private execute(command: Command): unknown {
    const [first, second, third, fourth] = command.args;
    switch (command.name) {
      case "get":
        return this.values.get(String(first)) ?? null;
      case "set": {
        const key = String(first);
        this.values.set(key, String(second));
        if (third === "EX") this.ttls.set(key, Number(fourth));
        return "OK";
      }
      case "sadd": {
        const key = String(first);
        const members = this.sets.get(key) ?? new Set<string>();
        members.add(String(second));
        this.sets.set(key, members);
        return 1;
      }
      case "del": {
        const key = String(first);
        const deleted = this.values.delete(key) || this.sets.delete(key);
        return deleted ? 1 : 0;
      }
      case "srem": {
        const key = String(first);
        const members = this.sets.get(key);
        return members?.delete(String(second)) ? 1 : 0;
      }
      default:
        throw new Error(`Unsupported command ${command.name}`);
    }
  }
}

function redisClient(client: InstrumentedRedis): Redis {
  return client as unknown as Redis;
}

describe("Redis pipeline fan-out", () => {
  let client: InstrumentedRedis;
  let cache: ReturnType<typeof createCache>;
  let sessions: SessionStore;

  beforeEach(() => {
    client = new InstrumentedRedis();
    cache = createCache(redisClient(client));
    sessions = new SessionStore(redisClient(client));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sets, reads, and deletes cache entries in batches with per-key TTLs", async () => {
    await cache.setMany([
      { key: "cache:a", value: { value: 1 }, ttlSeconds: 5 },
      { key: "cache:b", value: [2], ttlSeconds: 37 },
    ]);

    expect(client.pipelineExecCalls).toBe(1);
    expect(client.ttls.get("cache:a")).toBe(5);
    expect(client.ttls.get("cache:b")).toBe(37);
    await expect(cache.getMany(["cache:a", "cache:missing", "cache:b"])).resolves.toEqual([
      { value: 1 },
      null,
      [2],
    ]);
    await cache.delMany(["cache:a", "cache:b", "cache:a"]);
    await expect(cache.getMany(["cache:a", "cache:b"])).resolves.toEqual([null, null]);
  });

  it("registers and revokes sessions with one fan-out pipeline and independent TTLs", async () => {
    await sessions.addSessions([
      { walletAddress: "wallet-1", jti: "access-1", ttlSeconds: 900 },
      { walletAddress: "wallet-1", jti: "refresh-1", ttlSeconds: 604800 },
    ]);

    expect(client.pipelineExecCalls).toBe(1);
    expect(client.commands.slice(0, 4).map((command) => command.name)).toEqual([
      "set",
      "sadd",
      "set",
      "sadd",
    ]);
    expect(client.ttls.get("auth:jti:access-1")).toBe(900);
    expect(client.ttls.get("auth:jti:refresh-1")).toBe(604800);
    await expect(sessions.isActive("access-1")).resolves.toBe(true);
    await expect(sessions.removeAllSessions("wallet-1")).resolves.toBe(2);
    await expect(sessions.isActive("access-1")).resolves.toBe(false);
  });

  it("handles empty and maximum-boundary inputs without an empty Redis write", async () => {
    await expect(cache.getMany([])).resolves.toEqual([]);
    await expect(cache.setMany([])).resolves.toBeUndefined();
    await expect(cache.delMany([])).resolves.toBeUndefined();
    await expect(sessions.addSessions([])).resolves.toBeUndefined();
    expect(client.pipelineCalls).toBe(0);

    await cache.setMany([{ key: "boundary", value: true, ttlSeconds: 1 }]);
    expect(client.ttls.get("boundary")).toBe(1);
    await expect(
      cache.setMany(
        Array.from({ length: MAX_PIPELINE_COMMANDS + 1 }, (_, index) => ({
          key: `too-many-${index}`,
          value: index,
          ttlSeconds: 60,
        })),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(client.pipelineCalls).toBe(1);
  });

  it("rejects malformed keys, values, TTLs, and conflicting duplicate entries", async () => {
    await expect(cache.getMany([""])).rejects.toBeInstanceOf(TypeError);
    await expect(
      cache.setMany([{ key: "bad-ttl", value: 1, ttlSeconds: 0 }]),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      cache.setMany([{ key: "bad-value", value: undefined, ttlSeconds: 60 }]),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      cache.setMany([
        { key: "same", value: 1, ttlSeconds: 60 },
        { key: "same", value: 2, ttlSeconds: 60 },
      ]),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      sessions.addSessions([
        { walletAddress: "wallet-1", jti: "same", ttlSeconds: 60 },
        { walletAddress: "wallet-2", jti: "same", ttlSeconds: 60 },
      ]),
    ).rejects.toBeInstanceOf(TypeError);
    expect(client.pipelineCalls).toBe(0);
  });

  it("retries transient pipeline transport failures and records latency", async () => {
    const info = jest.spyOn(logger, "info");
    const warn = jest.spyOn(logger, "warn");
    client.queueBehavior({
      kind: "reject",
      error: Object.assign(new Error("socket unavailable"), { code: "ECONNRESET" }),
    });

    await cache.setMany([{ key: "retry", value: "ok", ttlSeconds: 60 }]);

    expect(client.pipelineExecCalls).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "redis_pipeline_retry", attempt: 1 }),
      expect.any(String),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "redis_pipeline_success",
        operation: "cache.set_many",
        latencyMs: expect.any(Number),
      }),
      expect.any(String),
    );
  });

  it("surfaces partial pipeline errors and retries only transient failed commands", async () => {
    client.queueBehavior({ kind: "partial", index: 1, error: new Error("wrong command") });
    await expect(
      cache.setMany([
        { key: "partial:a", value: 1, ttlSeconds: 60 },
        { key: "partial:b", value: 2, ttlSeconds: 60 },
      ]),
    ).rejects.toMatchObject({
      name: "RedisPipelineError",
      partial: true,
      failedIndexes: [1],
    });
    expect(client.pipelineExecCalls).toBe(1);

    client.queueBehavior({
      kind: "partial",
      index: 1,
      error: Object.assign(new Error("temporary reply failure"), { code: "ETIMEDOUT" }),
    });
    await cache.setMany([
      { key: "retry:a", value: 1, ttlSeconds: 60 },
      { key: "retry:b", value: 2, ttlSeconds: 60 },
    ]);
    expect(client.pipelineExecCalls).toBe(3);
    expect(client.commands.filter((command) => command.args[0] === "retry:b")).toHaveLength(2);
  });

  it("fails after the bounded retry budget and records the final failure", async () => {
    const errorLog = jest.spyOn(logger, "error");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      client.queueBehavior({
        kind: "reject",
        error: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      });
    }

    await expect(
      cache.setMany([{ key: "never-written", value: true, ttlSeconds: 60 }]),
    ).rejects.toBeInstanceOf(RedisPipelineError);
    expect(client.pipelineExecCalls).toBe(3);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "redis_pipeline_failure", outcome: "failure" }),
      expect.any(String),
    );
  });

  it("shares one instrumented Redis connection across session and cache fan-out", async () => {
    const before = client.roundTrips;
    await sessions.addSessions([
      { walletAddress: "wallet-2", jti: "access-2", ttlSeconds: 120 },
      { walletAddress: "wallet-2", jti: "refresh-2", ttlSeconds: 7200 },
    ]);
    await cache.setMany([
      { key: "shared:a", value: "a", ttlSeconds: 11 },
      { key: "shared:b", value: "b", ttlSeconds: 22 },
    ]);

    expect(client.pipelineExecCalls).toBe(2);
    expect(client.roundTrips - before).toBe(2);
    expect(client.commands).toHaveLength(6);
    expect(client.roundTrips).toBeLessThan(client.commands.length);
    await expect(cache.getMany(["shared:a", "shared:b"])).resolves.toEqual(["a", "b"]);
    await expect(sessions.isActive("refresh-2")).resolves.toBe(true);
  });
});
