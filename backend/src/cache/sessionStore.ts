import type Redis from "ioredis";
import { logger } from "../utils/logger";
import {
  executeRedisPipeline,
  rejectPipelineInput,
  validatePipelineCommandCount,
  type RedisPipelineCommand,
} from "./cacheService";
import { redis as defaultRedis } from "./redisClient";

export interface SessionRegistration {
  walletAddress: string;
  jti: string;
  ttlSeconds: number;
}

export class SessionStore {
  constructor(private readonly client: Redis = defaultRedis) {}

  private jtiKey(jti: string): string {
    return `auth:jti:${jti}`;
  }

  private walletKey(walletAddress: string): string {
    return `auth:wallet:${walletAddress}`;
  }

  private requireString(value: unknown, operation: string, reason: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      rejectPipelineInput("session", operation, reason);
    }
    return value;
  }

  private requireTtl(value: unknown, operation: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      rejectPipelineInput("session", operation, "ttl");
    }
    return value;
  }

  private logDirectFailure(operation: string, startedAt: number, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error("Redis operation failed");
    const name = /^[A-Za-z0-9_.-]{1,64}$/.test(normalized.name)
      ? normalized.name
      : "RedisError";
    logger.error(
      {
        event: "redis_operation_failure",
        subsystem: "session",
        operation,
        outcome: "failure",
        latencyMs: Date.now() - startedAt,
        errorName: name,
      },
      "Redis session operation failed",
    );
  }

  private normalizeRegistrations(entries: unknown): SessionRegistration[] {
    if (!Array.isArray(entries)) {
      rejectPipelineInput("session", "session.add_sessions", "entries");
    }
    const values = entries as unknown[];
    validatePipelineCommandCount(values.length * 2, "session.add_sessions", "session");
    const byJti = new Map<string, SessionRegistration>();
    values.forEach((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        rejectPipelineInput("session", "session.add_sessions", "entry");
      }
      const candidate = entry as Partial<SessionRegistration>;
      const walletAddress = this.requireString(
        candidate.walletAddress,
        "session.add_sessions",
        "wallet",
      );
      const jti = this.requireString(candidate.jti, "session.add_sessions", "jti");
      const ttlSeconds = this.requireTtl(candidate.ttlSeconds, "session.add_sessions");
      const previous = byJti.get(jti);
      if (
        previous &&
        (previous.walletAddress !== walletAddress || previous.ttlSeconds !== ttlSeconds)
      ) {
        rejectPipelineInput("session", "session.add_sessions", "duplicate_jti");
      }
      if (!previous) byJti.set(jti, { walletAddress, jti, ttlSeconds });
    });
    return [...byJti.values()];
  }

  async addSession(
    walletAddress: string,
    jti: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.addSessions([{ walletAddress, jti, ttlSeconds }]);
  }

  async addSessions(entries: readonly SessionRegistration[]): Promise<void> {
    const registrations = this.normalizeRegistrations(entries);
    if (this.addSession !== SessionStore.prototype.addSession) {
      for (const registration of registrations) {
        await this.addSession(
          registration.walletAddress,
          registration.jti,
          registration.ttlSeconds,
        );
      }
      return;
    }

    const commands: RedisPipelineCommand[] = registrations.flatMap(
      (registration) => [
        (pipeline) => {
          pipeline.set(
            this.jtiKey(registration.jti),
            registration.walletAddress,
            "EX",
            registration.ttlSeconds,
          );
        },
        (pipeline) => {
          pipeline.sadd(
            this.walletKey(registration.walletAddress),
            registration.jti,
          );
        },
      ],
    );
    await executeRedisPipeline(
      this.client,
      commands,
      "session.add_sessions",
      "session",
    );
  }

  async isActive(jti: string): Promise<boolean> {
    const validatedJti = this.requireString(jti, "session.is_active", "jti");
    const startedAt = Date.now();
    try {
      return (await this.client.get(this.jtiKey(validatedJti))) !== null;
    } catch (error) {
      this.logDirectFailure("session.is_active", startedAt, error);
      throw error;
    }
  }

  async removeSession(jti: string): Promise<void> {
    const validatedJti = this.requireString(jti, "session.remove_session", "jti");
    const startedAt = Date.now();
    let wallet: string | null;
    try {
      const storedWallet = await this.client.get(this.jtiKey(validatedJti));
      if (storedWallet === null) {
        wallet = null;
      } else {
        wallet = this.requireString(
          storedWallet,
          "session.remove_session",
          "stored_wallet",
        );
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw error;
      this.logDirectFailure("session.remove_session_lookup", startedAt, error);
      throw error;
    }

    const commands: RedisPipelineCommand[] = [
      (pipeline) => {
        pipeline.del(this.jtiKey(validatedJti));
      },
    ];
    if (wallet) {
      commands.push((pipeline) => {
        pipeline.srem(this.walletKey(wallet), validatedJti);
      });
    }
    await executeRedisPipeline(
      this.client,
      commands,
      "session.remove_session",
      "session",
    );
  }

  async removeSessions(jtis: readonly string[]): Promise<void> {
    if (!Array.isArray(jtis)) {
      rejectPipelineInput("session", "session.remove_sessions", "jtis");
    }
    const values = jtis as unknown[];
    validatePipelineCommandCount(values.length, "session.remove_sessions", "session");
    const uniqueJtis = [
      ...new Set(
        values.map((jti) =>
          this.requireString(jti, "session.remove_sessions", "jti"),
        ),
      ),
    ];
    const lookupResults = await executeRedisPipeline(
      this.client,
      uniqueJtis.map((jti) => (pipeline) => {
        pipeline.get(this.jtiKey(jti));
      }),
      "session.remove_sessions_lookup",
      "session",
    );

    const commands: RedisPipelineCommand[] = [];
    lookupResults.forEach((result, index) => {
      const wallet = result[1];
      if (wallet === null || wallet === undefined) return;
      const jti = uniqueJtis[index];
      if (!jti) throw new Error("Redis pipeline result index is invalid");
      const validatedWallet = this.requireString(
        wallet,
        "session.remove_sessions",
        "stored_wallet",
      );
      commands.push(
        (pipeline) => {
          pipeline.del(this.jtiKey(jti));
        },
        (pipeline) => {
          pipeline.srem(this.walletKey(validatedWallet), jti);
        },
      );
    });
    await executeRedisPipeline(
      this.client,
      commands,
      "session.remove_sessions",
      "session",
    );
  }

  async removeAllSessions(walletAddress: string): Promise<number> {
    const validatedWallet = this.requireString(
      walletAddress,
      "session.remove_all_sessions",
      "wallet",
    );
    const startedAt = Date.now();
    let rawJtis: string[];
    try {
      const storedJtis = await this.client.smembers(
        this.walletKey(validatedWallet),
      );
      if (!Array.isArray(storedJtis)) {
        rejectPipelineInput("session", "session.remove_all_sessions", "stored_jtis");
      }
      rawJtis = storedJtis;
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw error;
      this.logDirectFailure(
        "session.remove_all_sessions_lookup",
        startedAt,
        error,
      );
      throw error;
    }

    const jtis = [
      ...new Set(
        rawJtis.map((jti) =>
          this.requireString(jti, "session.remove_all_sessions", "stored_jti"),
        ),
      ),
    ];
    const commands: RedisPipelineCommand[] = jtis.map((jti) => (pipeline) => {
      pipeline.del(this.jtiKey(jti));
    });
    commands.push((pipeline) => {
      pipeline.del(this.walletKey(validatedWallet));
    });
    await executeRedisPipeline(
      this.client,
      commands,
      "session.remove_all_sessions",
      "session",
    );
    return jtis.length;
  }
}

export const sessionStore = new SessionStore();
