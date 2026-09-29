import { test, afterEach } from "node:test";
import assert from "node:assert";
import {
  TransactionIntentService,
  IntentNotFoundError,
  IntentStateError,
} from "../src/services/transactionIntentService";
import { InMemoryTransactionIntentRepository } from "../src/repositories/inMemoryTransactionIntentRepository";
import type { IntentConfig } from "../src/config/intentConfig";

const VALID_WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_WALLET = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const VALID_XDR = "AAAAAgAAAAA".padEnd(40, "A");

const shortTtlConfig: IntentConfig = { ttlMs: 50, maxSignAttempts: 2 };
const normalConfig: IntentConfig = { ttlMs: 300_000, maxSignAttempts: 5 };

function makeService(config: IntentConfig = normalConfig) {
  return new TransactionIntentService(new InMemoryTransactionIntentRepository(), config);
}

const validCreateInput = {
  idempotencyKey: "intent-key-0001",
  kind: "stake" as const,
  unsignedXdr: VALID_XDR,
};

afterEach(() => {});

test("createOrResumeIntent: creates a fresh intent", async () => {
  const service = makeService();
  const result = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  assert.strictEqual(result.mode, "created");
  assert.strictEqual(result.intent.status, "built");
  assert.strictEqual(result.intent.kind, "stake");
  assert.strictEqual(result.intent.ownerWallet, VALID_WALLET);
  assert.strictEqual(result.intent.attempts, 0);
  assert.strictEqual(result.intent.signAttempts, 0);
});

test("createOrResumeIntent: resumes an existing unexpired intent by idempotency key", async () => {
  const service = makeService();
  const first = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);
  const second = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  assert.strictEqual(second.mode, "resumed");
  assert.strictEqual(second.intent.id, first.intent.id);
});

test("createOrResumeIntent: rejects malformed input", async () => {
  const service = makeService();
  await assert.rejects(
    () => service.createOrResumeIntent({ idempotencyKey: "x", kind: "stake", unsignedXdr: VALID_XDR }, VALID_WALLET),
    /idempotencyKey|Invalid/i
  );
});

test("createOrResumeIntent: rejects an invalid owner wallet", async () => {
  const service = makeService();
  await assert.rejects(
    () => service.createOrResumeIntent(validCreateInput, "not-a-wallet"),
    /Invalid owner wallet/
  );
});

test("markAwaitingSignature -> attachSignedXdr -> recordSubmissionOutcome: normal path", async () => {
  const service = makeService();
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  const signing = await service.markAwaitingSignature(created.intent.id, VALID_WALLET);
  assert.strictEqual(signing.status, "awaiting_signature");
  assert.strictEqual(signing.signAttempts, 1);

  const signed = await service.attachSignedXdr(created.intent.id, VALID_WALLET, VALID_XDR);
  assert.strictEqual(signed.status, "submitted");
  assert.strictEqual(signed.signedXdr, VALID_XDR);
  assert.strictEqual(signed.attempts, 1);

  const confirmed = await service.recordSubmissionOutcome(created.intent.id, VALID_WALLET, {
    status: "confirmed",
    txHash: "abc123",
  });
  assert.strictEqual(confirmed.status, "confirmed");
  assert.strictEqual(confirmed.txHash, "abc123");
  assert.ok(confirmed.confirmedAt);
});

test("recordSignatureRejectedOrExpired: wallet rejection returns the intent to built for a resumable retry", async () => {
  const service = makeService();
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);
  await service.markAwaitingSignature(created.intent.id, VALID_WALLET);

  const rejected = await service.recordSignatureRejectedOrExpired(created.intent.id, VALID_WALLET, "rejected");
  assert.strictEqual(rejected.status, "built");
  assert.match(rejected.errorMessage ?? "", /rejected/i);

  // Boundary case: the SAME unsigned XDR is retried via the SAME intent id,
  // proving the original envelope is never resubmitted as a "new" intent.
  const retrySigning = await service.markAwaitingSignature(created.intent.id, VALID_WALLET);
  assert.strictEqual(retrySigning.status, "awaiting_signature");
  assert.strictEqual(retrySigning.signAttempts, 2);
  assert.strictEqual(retrySigning.unsignedXdr, VALID_XDR);
});

test("markAwaitingSignature: fails closed once maxSignAttempts is exhausted", async () => {
  const service = makeService({ ttlMs: 300_000, maxSignAttempts: 1 });
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  await service.markAwaitingSignature(created.intent.id, VALID_WALLET);
  await service.recordSignatureRejectedOrExpired(created.intent.id, VALID_WALLET, "rejected");

  const secondAttempt = await service.markAwaitingSignature(created.intent.id, VALID_WALLET);
  assert.strictEqual(secondAttempt.status, "failed");
  assert.match(secondAttempt.errorMessage ?? "", /Max sign attempts/);
});

test("expiresAt boundary: an intent left untouched past its TTL is marked expired on next read", async () => {
  const service = makeService(shortTtlConfig);
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  await new Promise((resolve) => setTimeout(resolve, 75));

  const fetched = await service.getIntent(created.intent.id, VALID_WALLET);
  assert.strictEqual(fetched.status, "expired");
});

test("createOrResumeIntent: an expired match under the same idempotency key requires a new key, not a silent duplicate", async () => {
  const service = makeService(shortTtlConfig);
  await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  await new Promise((resolve) => setTimeout(resolve, 75));

  await assert.rejects(
    () => service.createOrResumeIntent(validCreateInput, VALID_WALLET),
    /expired/i
  );
});

test("invalid-input path: attachSignedXdr rejects an intent that is not awaiting_signature", async () => {
  const service = makeService();
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  await assert.rejects(
    () => service.attachSignedXdr(created.intent.id, VALID_WALLET, VALID_XDR),
    IntentStateError
  );
});

test("invalid-input path: recordSubmissionOutcome rejects an intent that was never submitted", async () => {
  const service = makeService();
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  await assert.rejects(
    () =>
      service.recordSubmissionOutcome(created.intent.id, VALID_WALLET, {
        status: "confirmed",
        txHash: "abc",
      }),
    IntentStateError
  );
});

test("ownership boundary: a different wallet cannot read or mutate another wallet's intent", async () => {
  const service = makeService();
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);

  await assert.rejects(() => service.getIntent(created.intent.id, OTHER_WALLET), IntentNotFoundError);
  await assert.rejects(
    () => service.markAwaitingSignature(created.intent.id, OTHER_WALLET),
    IntentNotFoundError
  );
});

test("ownership boundary: a nonexistent intent id reports not-found, not a different error shape", async () => {
  const service = makeService();
  await assert.rejects(() => service.getIntent("does-not-exist", VALID_WALLET), IntentNotFoundError);
});

test("expireStaleIntents: sweeps untouched intents past TTL without a caller ever reading them (restart-during-work)", async () => {
  const service = makeService(shortTtlConfig);
  const a = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);
  const b = await service.createOrResumeIntent(
    { idempotencyKey: "intent-key-0002", kind: "unstake", unsignedXdr: VALID_XDR },
    VALID_WALLET
  );

  await new Promise((resolve) => setTimeout(resolve, 75));

  const expiredCount = await service.expireStaleIntents();
  assert.strictEqual(expiredCount, 2);

  const aAfter = await service.getIntent(a.intent.id, VALID_WALLET);
  const bAfter = await service.getIntent(b.intent.id, VALID_WALLET);
  assert.strictEqual(aAfter.status, "expired");
  assert.strictEqual(bAfter.status, "expired");
});

test("expireStaleIntents: a confirmed intent is never touched even after its TTL lapses", async () => {
  const service = makeService(shortTtlConfig);
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);
  await service.markAwaitingSignature(created.intent.id, VALID_WALLET);
  await service.attachSignedXdr(created.intent.id, VALID_WALLET, VALID_XDR);
  const confirmed = await service.recordSubmissionOutcome(created.intent.id, VALID_WALLET, {
    status: "confirmed",
    txHash: "abc123",
  });

  await new Promise((resolve) => setTimeout(resolve, 75));
  const expiredCount = await service.expireStaleIntents();

  assert.strictEqual(expiredCount, 0);
  const stillConfirmed = await service.getIntent(created.intent.id, VALID_WALLET);
  assert.strictEqual(stillConfirmed.status, "confirmed");
  assert.strictEqual(stillConfirmed.confirmedAt?.getTime(), confirmed.confirmedAt?.getTime());
});

test("recordSubmissionOutcome: failed path preserves the error message and does not set confirmedAt", async () => {
  const service = makeService();
  const created = await service.createOrResumeIntent(validCreateInput, VALID_WALLET);
  await service.markAwaitingSignature(created.intent.id, VALID_WALLET);
  await service.attachSignedXdr(created.intent.id, VALID_WALLET, VALID_XDR);

  const failed = await service.recordSubmissionOutcome(created.intent.id, VALID_WALLET, {
    status: "failed",
    errorMessage: "Soroban rejected transaction",
  });

  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(failed.errorMessage, "Soroban rejected transaction");
  assert.strictEqual(failed.confirmedAt, null);
});
