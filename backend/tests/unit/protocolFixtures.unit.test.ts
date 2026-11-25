import {
  buildArena,
  buildBackendTransactionRecord,
  buildCommitment,
  buildCompatibilityManifest,
  buildFixtureWithRetry,
  buildRound,
  buildTransaction,
  FixtureValidationError,
  isAllowedLifecycleTransition,
  resetFixtureSequenceForTest,
  type FixtureBuildMetrics,
  type FixtureLogEntry,
} from "../helpers/protocolFixtures";
import {
  MAX_ARENA_PLAYERS,
  MAX_METADATA_BYTES,
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
} from "../../../frontend/src/shared/lib/testing/protocolFixtures";
import goldenVectors from "../../../shared/stellar-xdr-golden-vectors.json";

describe("Protocol domain fixture builders (#1464)", () => {
  beforeEach(() => {
    resetFixtureSequenceForTest();
  });

  it("builds valid defaults across all protocol domain objects", () => {
    const arena = buildArena().build();
    const round = buildRound().build();
    const commitment = buildCommitment().build();
    const tx = buildTransaction().build();
    const manifest = buildCompatibilityManifest().build();

    expect(arena.network).toBe(TESTNET_PASSPHRASE);
    expect(round.arenaId).toBe(arena.id);
    expect(commitment.choice).toBe(0);
    expect(tx.status).toBe("queued");
    expect(manifest.schemaVersion).toBe(1);
  });

  it("handles boundary inputs (maxPlayers=256, max-size metadata)", () => {
    const maxArena = buildArena().withMaxPlayersBoundary().withMaxSizeMetadata().build();
    expect(maxArena.maxPlayers).toBe(MAX_ARENA_PLAYERS);
    expect((maxArena.metadata?.blob as string).length).toBe(MAX_METADATA_BYTES);
  });

  it("enforces invariants on .build() and allows explicit .buildInvalid() escape hatch", () => {
    expect(() => buildArena().withInvalidContractId().build()).toThrow(FixtureValidationError);
    expect(() => buildTransaction().withZeroAmount().build()).toThrow(FixtureValidationError);
    expect(() => buildRound().with({ state: "RESOLVED", resolvedOutcome: null }).build()).toThrow(
      FixtureValidationError,
    );

    const invalidArena = buildArena().withInvalidContractId().withNetworkMismatch().buildInvalid();
    expect(invalidArena.id).toBe("INVALID_CONTRACT_ID");
    expect(invalidArena.network).toBe(MAINNET_PASSPHRASE);

    const dupTx = buildTransaction().withDuplicatePayoutId("payout-dup").build();
    expect(dupTx.payoutId).toBe("payout-dup");
  });

  it("records success, failure, retry, and latency in buildFixtureWithRetry", async () => {
    const metrics: FixtureBuildMetrics = { success: 0, failure: 0, retry: 0, totalLatencyMs: 0 };
    const logs: FixtureLogEntry[] = [];
    let attempt = 0;

    const arena = await buildFixtureWithRetry(
      "Arena",
      () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient store error");
        return buildArena().build();
      },
      { maxRetries: 2, metrics, log: (e) => logs.push(e) },
    );

    expect(arena.status).toBe("Open");
    expect(metrics.success).toBe(1);
    expect(metrics.retry).toBe(1);
    expect(metrics.failure).toBe(0);
    expect(logs.map((l) => l.event)).toEqual(["fixture_build_retry", "fixture_build_success"]);

    await expect(
      buildFixtureWithRetry(
        "Transaction",
        () => {
          throw new Error("permanent failure");
        },
        { maxRetries: 1, metrics, log: (e) => logs.push(e) },
      ),
    ).rejects.toThrow("permanent failure");
    expect(metrics.failure).toBe(1);
    expect(metrics.retry).toBe(2);
  });

  it("integration: aligns backend TransactionRecord, lifecycle spec, and shared XDR golden vectors", () => {
    const record = buildBackendTransactionRecord({
      arenaId: goldenVectors.contractId,
      network: goldenVectors.networkPassphrase,
      amountStroops: "50000000",
    });

    expect(record.arenaId).toBe(goldenVectors.contractId);
    expect(record.amount).toBe(5);
    expect(isAllowedLifecycleTransition("round", "OPEN", "CLOSED")).toBe(true);
    expect(isAllowedLifecycleTransition("round", "OPEN", "SETTLED")).toBe(false);
    expect(isAllowedLifecycleTransition("transaction", "submitted", "confirmed")).toBe(true);
    expect(isAllowedLifecycleTransition("transaction", "confirmed", "submitted")).toBe(false);
  });
});
