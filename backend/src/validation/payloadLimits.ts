import { z } from "zod";
import { HttpError } from "../utils/apiError";
import { logger } from "../utils/logger";
import { payloadLimitRejectionsTotal } from "../utils/metrics";

/**
 * Schema-level limits for untrusted metadata and event payloads (#1455).
 * Design note: docs/design/payload-limits.md.
 *
 * Every free-form value that is persisted (Prisma JSON columns, Mongo Mixed
 * fields) or re-emitted (SSE/events) must pass through one of these checks
 * *before* the write. The walk is iterative with early exit, so a hostile
 * payload costs at most `maxNodes` visits regardless of its real size.
 */

export interface PayloadLimits {
  /** Max nesting depth; a flat object is depth 1. */
  maxDepth: number;
  /** Max characters in any string value or object key. */
  maxStringLength: number;
  /** Max elements in any single array. */
  maxArrayLength: number;
  /** Max keys in any single object. */
  maxObjectKeys: number;
  /** Max total values visited (objects + arrays + scalars). */
  maxNodes: number;
}

export type PayloadLimitKind = "depth" | "string" | "array" | "keys" | "nodes" | "type";

export interface PayloadLimitViolation {
  kind: PayloadLimitKind;
  /** JSON-path-like location of the offending value, e.g. ["a", 3, "b"]. */
  path: Array<string | number>;
  limit: number;
  actual: number;
}

/** Named persistence/emission boundaries and their limits. */
export const PAYLOAD_LIMITS = {
  /** Generic caller-supplied metadata (requests, audit context). */
  metadata: { maxDepth: 4, maxStringLength: 1_024, maxArrayLength: 100, maxObjectKeys: 50, maxNodes: 2_000 },
  /** Arena metadata persisted on creation. */
  arena_metadata: { maxDepth: 4, maxStringLength: 512, maxArrayLength: 50, maxObjectKeys: 32, maxNodes: 500 },
  /**
   * Round metadata persisted on resolve. Sized for RoundInputSchema's
   * 500-player ceiling: playerChoices + eliminatedPlayers + payouts.
   */
  round_metadata: { maxDepth: 5, maxStringLength: 256, maxArrayLength: 1_000, maxObjectKeys: 32, maxNodes: 20_000 },
  /** Admin audit-log context (Mongo Mixed field). */
  audit_metadata: { maxDepth: 4, maxStringLength: 2_048, maxArrayLength: 200, maxObjectKeys: 64, maxNodes: 5_000 },
} as const satisfies Record<string, PayloadLimits>;

export type PayloadBoundary = keyof typeof PAYLOAD_LIMITS;

/** Scalar string bounds shared by route schemas. */
export const STRING_LIMITS = {
  shortText: 128,
  reason: 512,
  pushToken: 512,
  email: 254,
} as const;

/**
 * Return the first limit the value breaks, or null if it is within bounds.
 * Non-JSON values (functions, symbols, bigint) are reported as `type`.
 */
export function findPayloadLimitViolation(value: unknown, limits: PayloadLimits): PayloadLimitViolation | null {
  const stack: Array<{ value: unknown; depth: number; path: Array<string | number> }> = [{ value, depth: 0, path: [] }];
  let nodes = 0;

  while (stack.length > 0) {
    const { value: current, depth, path } = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) return { kind: "nodes", path, limit: limits.maxNodes, actual: nodes };

    if (current === null || current === undefined || typeof current === "boolean" || typeof current === "number") continue;
    if (typeof current === "string") {
      if (current.length > limits.maxStringLength) {
        return { kind: "string", path, limit: limits.maxStringLength, actual: current.length };
      }
      continue;
    }
    if (current instanceof Date) continue;
    if (typeof current !== "object") return { kind: "type", path, limit: 0, actual: 0 };

    const childDepth = depth + 1;
    if (childDepth > limits.maxDepth) return { kind: "depth", path, limit: limits.maxDepth, actual: childDepth };

    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayLength) {
        return { kind: "array", path, limit: limits.maxArrayLength, actual: current.length };
      }
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push({ value: current[i], depth: childDepth, path: [...path, i] });
      continue;
    }

    const keys = Object.keys(current);
    if (keys.length > limits.maxObjectKeys) {
      return { kind: "keys", path, limit: limits.maxObjectKeys, actual: keys.length };
    }
    for (const key of keys) {
      if (key.length > limits.maxStringLength) {
        return { kind: "string", path: [...path, key], limit: limits.maxStringLength, actual: key.length };
      }
      stack.push({ value: (current as Record<string, unknown>)[key], depth: childDepth, path: [...path, key] });
    }
  }
  return null;
}

function describe(violation: PayloadLimitViolation): string {
  const where = violation.path.length ? violation.path.join(".") : "<root>";
  return `${where}: ${violation.kind} limit ${violation.limit} exceeded`;
}

function recordRejection(boundary: string, violation: PayloadLimitViolation): void {
  payloadLimitRejectionsTotal.inc({ boundary, limit: violation.kind });
  logger.warn(
    { event: "payload_limit_rejected", boundary, kind: violation.kind, path: violation.path, limit: violation.limit, actual: violation.actual },
    "payload rejected by schema limits",
  );
}

/**
 * Thrown when a server-side persistence boundary receives an oversized
 * payload. It is an HttpError (413) so the shared error handler returns a
 * client error instead of a masked 500.
 */
export class PayloadLimitError extends HttpError {
  constructor(
    public readonly boundary: string,
    public readonly violation: PayloadLimitViolation,
  ) {
    super(413, "PAYLOAD_LIMIT_EXCEEDED", `Payload for ${boundary} rejected (${describe(violation)})`);
    this.name = "PayloadLimitError";
  }
}

/**
 * Enforce limits before a write. Throws PayloadLimitError (never partially
 * persists), and returns the value unchanged otherwise so it can wrap
 * existing expressions.
 */
export function enforcePayloadLimits<T>(value: T, boundary: PayloadBoundary): T {
  const violation = findPayloadLimitViolation(value, PAYLOAD_LIMITS[boundary]);
  if (violation) {
    recordRejection(boundary, violation);
    throw new PayloadLimitError(boundary, violation);
  }
  return value;
}

/**
 * Zod schema for free-form metadata: a plain JSON object within the named
 * boundary's limits. Violations surface as a normal 400 VALIDATION_ERROR.
 */
export function boundedMetadataSchema(boundary: PayloadBoundary = "metadata") {
  return z.record(z.unknown()).superRefine((value, ctx) => {
    const violation = findPayloadLimitViolation(value, PAYLOAD_LIMITS[boundary]);
    if (violation) {
      recordRejection(boundary, violation);
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: violation.path, message: describe(violation) });
    }
  });
}

/** Bounded, trimmed string for untrusted text fields. */
export function boundedString(max: number) {
  return z.string().trim().max(max, `must be at most ${max} characters`);
}
