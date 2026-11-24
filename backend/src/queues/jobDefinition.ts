/**
 * Versioned job payload schemas and defineJob helper (#1839).
 *
 * Every queue job type has a versioned, Zod-validated payload. Producers stamp
 * the `v` field; consumers validate and route by version. Unknown or invalid
 * payloads are dead-lettered via `deadLetterJob` — they never crash a worker.
 *
 * Time:  O(1) per validation (Zod parse is linear in payload size, constant for fixed schemas)
 * Space: O(1) per schema (schemas are singletons, shared across worker instances)
 */

import { z, type ZodType } from "zod";

// ─── Version envelope ─────────────────────────────────────────────────────────

const VERSION_MIN = 1 as const;

/** Minimum wrapper stamped on every job produced by this codebase. */
export const JobEnvelopeSchema = z.object({
  /** Payload schema version; defaults to 1 for the initial schema. */
  v: z.number().int().min(VERSION_MIN),
});

export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;

// ─── Job definition registry ──────────────────────────────────────────────────

export interface JobDefinition<Name extends string, Current extends number, Payload> {
  name: Name;
  currentVersion: Current;
  /** Parse and validate a raw job data object; returns null on schema mismatch. */
  parse(data: unknown): Payload | null;
}

/**
 * Define a named, versioned job type.
 *
 * @param name         Canonical job type name (matches the BullMQ job name).
 * @param version      Current (latest) payload schema version.
 * @param schema       Zod schema for the current version payload (must include `v`).
 * @returns A `JobDefinition` usable by both producers and consumers.
 */
export function defineJob<Name extends string, V extends number, T extends JobEnvelope>(
  name: Name,
  version: V,
  schema: ZodType<T>,
): JobDefinition<Name, V, T> {
  return {
    name,
    currentVersion: version,
    parse(data: unknown): T | null {
      const result = schema.safeParse(data);
      return result.success ? result.data : null;
    },
  };
}

// ─── Payout queue payload ─────────────────────────────────────────────────────

/**
 * v1 payout confirmation job. Dispatched when a winner payout transaction is
 * submitted on-chain and needs confirmation reconciliation.
 */
export const PayoutJobSchema = JobEnvelopeSchema.extend({
  v: z.literal(1),
  transactionId: z.string().uuid(),
  arenaId: z.string(),
});
export type PayoutJobPayload = z.infer<typeof PayoutJobSchema>;

export const PayoutJob = defineJob("payout-confirm", 1, PayoutJobSchema);

// ─── Reconcile queue payload ──────────────────────────────────────────────────

/**
 * v1 reconciliation job. Bulk background jobs that reconcile submitted
 * transactions against the ledger. Lower priority than payouts.
 */
export const ReconcileJobSchema = JobEnvelopeSchema.extend({
  v: z.literal(1),
  transactionId: z.string().uuid(),
});
export type ReconcileJobPayload = z.infer<typeof ReconcileJobSchema>;

export const ReconcileJob = defineJob("tx-reconcile", 1, ReconcileJobSchema);

// ─── Notification queue payload ───────────────────────────────────────────────

/**
 * v1 notification job. Enqueued when an arena event requires a push or webhook
 * notification to be dispatched.
 */
export const NotificationJobSchema = JobEnvelopeSchema.extend({
  v: z.literal(1),
  eventType: z.string().min(1),
  aggregateId: z.string(),
  payload: z.record(z.unknown()),
});
export type NotificationJobPayload = z.infer<typeof NotificationJobSchema>;

export const NotificationJob = defineJob("notify", 1, NotificationJobSchema);
