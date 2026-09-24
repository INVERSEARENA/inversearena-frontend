/**
 * #1455 — schema-level limits for untrusted metadata and event payloads.
 * Oversized strings, arrays and nested metadata must be rejected *before*
 * persistence.
 */
import { describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { boundAuditMetadata } from "../src/middleware/auditLog";
import { errorHandler } from "../src/middleware/errorHandler";
import { asyncHandler } from "../src/middleware/validate";
import { RoundRepository } from "../src/repositories/roundRepository";
import type { RoundMetadata, RoundResolution } from "../src/types/round";
import { register } from "../src/utils/metrics";
import {
  PAYLOAD_LIMITS,
  PayloadLimitError,
  boundedMetadataSchema,
  boundedString,
  enforcePayloadLimits,
  findPayloadLimitViolation,
  type PayloadLimits,
} from "../src/validation/payloadLimits";

const SMALL: PayloadLimits = { maxDepth: 2, maxStringLength: 5, maxArrayLength: 3, maxObjectKeys: 2, maxNodes: 20 };

function nest(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let i = 0; i < depth - 1; i += 1) value = { a: value };
  return value;
}

describe("findPayloadLimitViolation", () => {
  it("accepts scalars and values exactly at every limit", () => {
    for (const scalar of [null, undefined, true, 1, "x", new Date()]) {
      expect(findPayloadLimitViolation(scalar, SMALL)).toBeNull();
    }
    expect(findPayloadLimitViolation({ a: "12345", b: [1, 2, 3] }, SMALL)).toBeNull();
    expect(findPayloadLimitViolation(nest(2), SMALL)).toBeNull();
  });

  it("rejects strings one character over the limit", () => {
    expect(findPayloadLimitViolation({ a: "123456" }, SMALL)).toEqual({ kind: "string", path: ["a"], limit: 5, actual: 6 });
  });

  it("rejects oversized object keys", () => {
    expect(findPayloadLimitViolation({ abcdef: 1 }, SMALL)?.kind).toBe("string");
  });

  it("rejects arrays one element over the limit", () => {
    expect(findPayloadLimitViolation({ a: [1, 2, 3, 4] }, SMALL)).toMatchObject({ kind: "array", path: ["a"], actual: 4 });
  });

  it("rejects too many keys", () => {
    expect(findPayloadLimitViolation({ a: 1, b: 2, c: 3 }, SMALL)?.kind).toBe("keys");
  });

  it("rejects nesting one level too deep, including inside arrays", () => {
    expect(findPayloadLimitViolation(nest(3), SMALL)?.kind).toBe("depth");
    expect(findPayloadLimitViolation({ a: [[1]] }, SMALL)?.kind).toBe("depth");
  });

  it("caps total work with the node budget", () => {
    const wide = { ...PAYLOAD_LIMITS.metadata, maxArrayLength: 10_000, maxNodes: 50 };
    expect(findPayloadLimitViolation({ a: Array.from({ length: 1_000 }, () => 1) }, wide)?.kind).toBe("nodes");
  });

  it("does not stack-overflow on pathologically deep input", () => {
    const deep = nest(100_000);
    expect(findPayloadLimitViolation(deep, PAYLOAD_LIMITS.metadata)?.kind).toBe("depth");
  });

  it("rejects non-JSON values", () => {
    expect(findPayloadLimitViolation({ f: () => 1 }, SMALL)?.kind).toBe("type");
    expect(findPayloadLimitViolation({ b: BigInt(1) }, SMALL)?.kind).toBe("type");
  });
});

describe("enforcePayloadLimits", () => {
  it("returns the value unchanged when within limits", () => {
    const value = { ok: true };
    expect(enforcePayloadLimits(value, "metadata")).toBe(value);
  });

  it("throws a 413 PayloadLimitError and records a metric", async () => {
    let caught: unknown;
    try {
      enforcePayloadLimits({ s: "x".repeat(PAYLOAD_LIMITS.arena_metadata.maxStringLength + 1) }, "arena_metadata");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PayloadLimitError);
    expect((caught as PayloadLimitError).status).toBe(413);
    expect((caught as PayloadLimitError).code).toBe("PAYLOAD_LIMIT_EXCEEDED");
    const metrics = await register.getSingleMetricAsString("inversearena_payload_limit_rejections_total");
    expect(metrics).toContain('boundary="arena_metadata",limit="string"');
  });

  it("is deterministic on retry of the same payload (duplicate delivery)", () => {
    const payload = { list: Array.from({ length: PAYLOAD_LIMITS.metadata.maxArrayLength + 1 }, (_, i) => i) };
    expect(() => enforcePayloadLimits(payload, "metadata")).toThrow(PayloadLimitError);
    expect(() => enforcePayloadLimits(payload, "metadata")).toThrow(PayloadLimitError);
  });
});

describe("zod helpers", () => {
  it("boundedMetadataSchema surfaces violations as zod issues with a path", () => {
    const result = boundedMetadataSchema().safeParse({ nested: { note: "x".repeat(2_000) } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.path).toEqual(["nested", "note"]);
    expect(boundedMetadataSchema().safeParse({ note: "fine" }).success).toBe(true);
    expect(boundedMetadataSchema().safeParse([1, 2]).success).toBe(false);
  });

  it("boundedString trims then enforces the max", () => {
    expect(boundedString(3).safeParse("  abc  ").success).toBe(true);
    expect(boundedString(3).safeParse("abcd").success).toBe(false);
  });
});

describe("boundAuditMetadata", () => {
  it("passes small metadata through and drops null", () => {
    expect(boundAuditMetadata({ dryRun: true })).toEqual({ dryRun: true });
    expect(boundAuditMetadata(undefined)).toBeUndefined();
    expect(boundAuditMetadata(null)).toBeUndefined();
  });

  it("replaces oversized metadata with a marker instead of dropping the entry", () => {
    const big = { rows: Array.from({ length: PAYLOAD_LIMITS.audit_metadata.maxArrayLength + 1 }, () => 1) };
    expect(boundAuditMetadata(big)).toEqual({ truncated: true, limit: "array", path: "rows" });
    expect(boundAuditMetadata("str")).toMatchObject({ truncated: true });
  });
});

describe("round metadata persistence (integration)", () => {
  function repoWith(update: unknown) {
    const prisma = {
      round: { update },
      $transaction: jest.fn(),
    } as unknown as PrismaClient;
    return new RoundRepository(prisma);
  }

  const resolution: RoundResolution = { eliminatedPlayers: [], payouts: [] } as unknown as RoundResolution;

  it("persists metadata within limits", async () => {
    const update = jest.fn(async () => ({}));
    const metadata: RoundMetadata = { playerChoices: [], oracleYield: 5, randomSeed: undefined, resolution: undefined };
    await repoWith(update).saveResolution("r1", resolution, metadata);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized metadata before any database write", async () => {
    const update = jest.fn(async () => ({}));
    const metadata = {
      playerChoices: Array.from({ length: PAYLOAD_LIMITS.round_metadata.maxArrayLength + 1 }, () => ({ userId: "u", choice: "heads", stake: 1 })),
      oracleYield: 5,
      randomSeed: undefined,
      resolution: undefined,
    } as unknown as RoundMetadata;
    await expect(repoWith(update).saveResolution("r1", resolution, metadata)).rejects.toBeInstanceOf(PayloadLimitError);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("HTTP boundary (integration)", () => {
  const persisted: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.post(
    "/meta",
    asyncHandler(async (req, res) => {
      const body = z.object({ metadata: boundedMetadataSchema() }).parse(req.body);
      persisted.push(enforcePayloadLimits(body.metadata, "metadata"));
      res.status(201).json({ ok: true });
    }),
  );
  app.use(errorHandler);

  it("accepts in-bounds metadata and rejects nested/oversized metadata with 400 before persistence", async () => {
    await request(app).post("/meta").send({ metadata: { a: 1 } }).expect(201);
    const res = await request(app).post("/meta").send({ metadata: nest(PAYLOAD_LIMITS.metadata.maxDepth + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(persisted).toHaveLength(1);
  });
});
