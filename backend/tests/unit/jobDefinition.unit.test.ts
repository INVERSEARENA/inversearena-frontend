import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  defineJob,
  PayoutJob,
  ReconcileJob,
  NotificationJob,
  JobEnvelopeSchema,
} from "../../src/queues/jobDefinition";
import { deadLetterJob } from "../../src/queues/txQueue";

test("defineJob parses valid versioned payload", () => {
  const payload = {
    v: 1,
    transactionId: "11111111-1111-1111-1111-111111111111",
    arenaId: "arena-xyz",
  };

  const parsed = PayoutJob.parse(payload);
  assert.ok(parsed !== null);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.transactionId, "11111111-1111-1111-1111-111111111111");
  assert.equal(parsed.arenaId, "arena-xyz");
});

test("defineJob returns null on invalid payload without throwing", () => {
  const invalid = {
    v: 1,
    transactionId: "not-a-uuid",
  };

  const parsed = PayoutJob.parse(invalid);
  assert.equal(parsed, null);
});

test("consumer handles v(n-1) payload when backward-compatibility schema is used", () => {
  // Simulate v2 job definition that supports v1 and v2
  const V1Schema = JobEnvelopeSchema.extend({
    v: z.literal(1),
    transactionId: z.string().uuid(),
  });

  const V2Schema = JobEnvelopeSchema.extend({
    v: z.literal(2),
    transactionId: z.string().uuid(),
    retryReason: z.string().optional(),
  });

  const MultiVersionSchema = z.discriminatedUnion("v", [V1Schema, V2Schema]);
  const VersionedReconcile = defineJob("tx-reconcile", 2, MultiVersionSchema);

  // v1 payload (v(n-1))
  const v1Payload = { v: 1, transactionId: "22222222-2222-2222-2222-222222222222" };
  const parsedV1 = VersionedReconcile.parse(v1Payload);
  assert.ok(parsedV1 !== null);
  assert.equal(parsedV1.v, 1);
  assert.equal(parsedV1.transactionId, "22222222-2222-2222-2222-222222222222");

  // v2 payload (v(n))
  const v2Payload = {
    v: 2,
    transactionId: "22222222-2222-2222-2222-222222222222",
    retryReason: "timeout",
  };
  const parsedV2 = VersionedReconcile.parse(v2Payload);
  assert.ok(parsedV2 !== null);
  assert.equal(parsedV2.v, 2);
});

test("deadLetterJob logs and does not throw on invalid payload", () => {
  assert.doesNotThrow(() => {
    deadLetterJob({
      queue: "tx-reconcile",
      jobId: "job-999",
      reason: "invalid_schema",
      raw: { bad: "data" },
    });
  });
});
