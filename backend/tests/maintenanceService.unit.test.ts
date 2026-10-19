import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { MaintenanceService, deriveMaintenanceStatus } from "../src/services/maintenanceService";
import { MaintenanceWindowModel } from "../src/db/models/maintenanceWindow.model";
import {
  setRpcServerForTest,
  setCircuitBreakerForTest,
  resetLedgerClockCacheForTest,
} from "../src/services/ledgerClock";
import { CircuitBreaker } from "../src/utils/circuitBreaker";

// A generous breaker so these tests exercise MaintenanceService, not the
// shared circuit breaker's own thresholds.
function freshBreaker(): CircuitBreaker {
  return new CircuitBreaker({
    timeout: 1000,
    errorThresholdPercentage: 100,
    resetTimeout: 100,
    volumeThreshold: 1000,
  });
}

/** Stubs the ledger clock's RPC seam so getCurrentLedgerSequence() resolves to `sequence`. */
function stubLedgerAt(sequence: number): void {
  resetLedgerClockCacheForTest();
  setCircuitBreakerForTest(freshBreaker());
  setRpcServerForTest({
    getLatestLedger: async () => ({ id: "x", sequence, protocolVersion: 22 }),
  } as never);
}

afterEach(() => {
  mock.reset();
  setRpcServerForTest(null);
  setCircuitBreakerForTest(null);
});

// ── Pure state-transition function ──────────────────────────────────────

test("deriveMaintenanceStatus: scheduled before the start ledger", () => {
  const status = deriveMaintenanceStatus(
    { startLedgerSequence: 100, endLedgerSequence: 200, cancelledAt: null },
    99,
  );
  assert.strictEqual(status, "scheduled");
});

test("deriveMaintenanceStatus: active exactly at the start ledger boundary", () => {
  const status = deriveMaintenanceStatus(
    { startLedgerSequence: 100, endLedgerSequence: 200, cancelledAt: null },
    100,
  );
  assert.strictEqual(status, "active");
});

test("deriveMaintenanceStatus: active between start and end", () => {
  const status = deriveMaintenanceStatus(
    { startLedgerSequence: 100, endLedgerSequence: 200, cancelledAt: null },
    150,
  );
  assert.strictEqual(status, "active");
});

test("deriveMaintenanceStatus: completed exactly at the end ledger boundary", () => {
  const status = deriveMaintenanceStatus(
    { startLedgerSequence: 100, endLedgerSequence: 200, cancelledAt: null },
    200,
  );
  assert.strictEqual(status, "completed");
});

test("deriveMaintenanceStatus: an indefinite window (no end) never completes on its own", () => {
  const status = deriveMaintenanceStatus(
    { startLedgerSequence: 100, endLedgerSequence: null, cancelledAt: null },
    1_000_000,
  );
  assert.strictEqual(status, "active");
});

test("deriveMaintenanceStatus: cancelled is terminal regardless of ledger position", () => {
  const status = deriveMaintenanceStatus(
    { startLedgerSequence: 100, endLedgerSequence: 200, cancelledAt: new Date() },
    150,
  );
  assert.strictEqual(status, "cancelled");
});

// ── Service methods ──────────────────────────────────────────────────────

beforeEach(() => {
  stubLedgerAt(500);
});

test("MaintenanceService.schedule: rejects an end ledger at or before the start ledger", async () => {
  const service = new MaintenanceService();
  await assert.rejects(
    () =>
      service.schedule({
        scheduledBy: "admin-1",
        startLedgerSequence: 600,
        endLedgerSequence: 600,
        reason: "upgrade",
      }),
    /endLedgerSequence must be greater/,
  );
});

test("MaintenanceService.schedule: rejects a start ledger already in the past", async () => {
  const service = new MaintenanceService();
  await assert.rejects(
    () =>
      service.schedule({
        scheduledBy: "admin-1",
        startLedgerSequence: 100,
        endLedgerSequence: 700,
        reason: "upgrade",
      }),
    /must not be in the past/,
  );
});

test("MaintenanceService.schedule: persists a valid window and reports it as scheduled", async () => {
  const created: Record<string, unknown> = {
    _id: "win-1",
    startLedgerSequence: 600,
    endLedgerSequence: 700,
    reason: "upgrade",
    scheduledBy: "admin-1",
    cancelledAt: null,
    createdAt: new Date(),
  };
  mock.method(MaintenanceWindowModel, "create", async () => created);

  const service = new MaintenanceService();
  const window = await service.schedule({
    scheduledBy: "admin-1",
    startLedgerSequence: 600,
    endLedgerSequence: 700,
    reason: "upgrade",
  });

  assert.strictEqual(window.status, "scheduled");
  assert.strictEqual(window.id, "win-1");
});

test("MaintenanceService.cancel: 404s for an unknown window", async () => {
  mock.method(MaintenanceWindowModel, "findById", async () => null);
  const service = new MaintenanceService();

  await assert.rejects(
    () => service.cancel("missing", "admin-1"),
    (err: unknown) => (err as { status: number }).status === 404,
  );
});

test("MaintenanceService.cancel: rejects cancelling an already-completed window", async () => {
  const doc = {
    _id: "win-1",
    startLedgerSequence: 100,
    endLedgerSequence: 200,
    cancelledAt: null,
    save: async () => {},
  };
  mock.method(MaintenanceWindowModel, "findById", async () => doc);
  stubLedgerAt(999); // past the end ledger

  const service = new MaintenanceService();
  await assert.rejects(
    () => service.cancel("win-1", "admin-1"),
    (err: unknown) => (err as { status: number }).status === 409,
  );
});

test("MaintenanceService.cancel: cancels an active window", async () => {
  const doc: Record<string, unknown> = {
    _id: "win-1",
    startLedgerSequence: 100,
    endLedgerSequence: 700,
    cancelledAt: null,
    createdAt: new Date(),
    scheduledBy: "admin-1",
    reason: "upgrade",
    save: async () => {},
  };
  mock.method(MaintenanceWindowModel, "findById", async () => doc);

  const service = new MaintenanceService();
  const result = await service.cancel("win-1", "admin-2");

  assert.strictEqual(result.status, "cancelled");
  assert.strictEqual(doc.cancelledBy, "admin-2");
  assert.ok(doc.cancelledAt instanceof Date);
});

test("MaintenanceService.getStatus: reports inactive when no window covers the current ledger", async () => {
  mock.method(MaintenanceWindowModel, "find", () => ({
    sort: () => Promise.resolve([]),
  }));

  const service = new MaintenanceService();
  const status = await service.getStatus();

  assert.strictEqual(status.active, false);
  assert.strictEqual(status.window, null);
  assert.strictEqual(status.currentLedgerSequence, 500);
});

test("MaintenanceService.getStatus: reports the active window when the current ledger falls inside it", async () => {
  const doc = {
    _id: "win-1",
    startLedgerSequence: 400,
    endLedgerSequence: 700,
    cancelledAt: null,
    createdAt: new Date(),
    scheduledBy: "admin-1",
    reason: "upgrade",
  };
  mock.method(MaintenanceWindowModel, "find", () => ({
    sort: () => Promise.resolve([doc]),
  }));

  const service = new MaintenanceService();
  const status = await service.getStatus();

  assert.strictEqual(status.active, true);
  assert.strictEqual(status.window?.id, "win-1");
});
