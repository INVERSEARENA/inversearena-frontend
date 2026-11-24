/**
 * Repository-wide typed fixture builders for InverseArena protocol domain objects (#1464).
 *
 * Enforces valid defaults and invariants on `.build()`, while exposing explicit
 * invalid-state helpers (`.buildInvalid()`) for negative and edge-case testing.
 */

export const FIXTURE_SCHEMA_VERSION = 1;

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const STANDALONE_PASSPHRASE = "Standalone Network ; February 2017";

export const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
export const VALID_FACTORY_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const VALID_WALLET_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const VALID_RECIPIENT_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

export const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
export const WALLET_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
export const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

export const MAX_ARENA_PLAYERS = 256;
export const MAX_METADATA_BYTES = 16 * 1024;

export type ArenaStatus = "Open" | "Active" | "Finished" | "Cancelled" | "Settled";
export type RoundState = "OPEN" | "CLOSED" | "RESOLVED" | "SETTLED";
export type TransactionStatus = "queued" | "submitted" | "confirmed" | "failed" | "dead" | "unknown";

export interface ArenaFixture {
  schemaVersion: number;
  id: string;
  network: string;
  status: ArenaStatus;
  entryFeeStroops: string;
  maxPlayers: number;
  roundNumber: number;
  createdBy: string;
  rematchOf: string | null;
  metadata?: Record<string, unknown>;
}

export interface RoundFixture {
  schemaVersion: number;
  id: string;
  arenaId: string;
  network: string;
  roundNumber: number;
  state: RoundState;
  deadlineLedger: number;
  resolvedOutcome: "HEADS" | "TAILS" | null;
}

export interface CommitmentFixture {
  schemaVersion: number;
  arenaId: string;
  roundNumber: number;
  player: string;
  choice: 0 | 1;
  saltHex: string;
  commitmentHash: string;
  ledgerSequence: number;
}

export interface TransactionFixture {
  schemaVersion: number;
  id: string;
  payoutId: string;
  arenaId: string;
  roundNumber: number;
  recipient: string;
  amountStroops: string;
  status: TransactionStatus;
  txHash: string | null;
  attempts: number;
  network: string;
}

export interface CompatibilityManifestFixture {
  schemaVersion: number;
  network: string;
  configRevision: number;
  contracts: Record<"arena" | "factory" | "payout" | "staking", { version: string }>;
  capabilities: Record<string, boolean>;
}

export class FixtureValidationError extends Error {
  constructor(
    readonly domain: string,
    readonly issues: string[],
  ) {
    super(`Invalid ${domain} fixture: ${issues.join("; ")}`);
    this.name = "FixtureValidationError";
  }
}

export interface FixtureBuildMetrics {
  success: number;
  failure: number;
  retry: number;
  totalLatencyMs: number;
}

export interface FixtureLogEntry {
  event: "fixture_build_success" | "fixture_build_failure" | "fixture_build_retry";
  domain: string;
  latencyMs: number;
  attempts: number;
  error?: string;
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export function resetFixtureSequenceForTest(): void {
  seqCounter = 0;
}

function validatePositiveStroops(value: string, field: string, issues: string[]): void {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    issues.push(`${field} must be a positive integer stroop string`);
  }
}

abstract class BaseFixtureBuilder<T> {
  protected state: T;
  protected abstract readonly domain: string;

  constructor(initial: T) {
    this.state = structuredClone(initial);
  }

  with(patch: Partial<T>): this {
    this.state = { ...this.state, ...patch };
    return this;
  }

  protected abstract validate(value: T): string[];

  build(): T {
    const snapshot = structuredClone(this.state);
    const issues = this.validate(snapshot);
    if (issues.length > 0) {
      throw new FixtureValidationError(this.domain, issues);
    }
    return snapshot;
  }

  /**
   * Explicit escape hatch for negative/invalid-state tests.
   */
  buildInvalid(mutator?: (draft: T) => void): T {
    const snapshot = structuredClone(this.state);
    mutator?.(snapshot);
    return snapshot;
  }
}

export class ArenaFixtureBuilder extends BaseFixtureBuilder<ArenaFixture> {
  protected readonly domain = "Arena";

  constructor(seq = nextSeq()) {
    super({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      id: VALID_CONTRACT_ID,
      network: TESTNET_PASSPHRASE,
      status: "Open",
      entryFeeStroops: "10000000",
      maxPlayers: 16,
      roundNumber: 1,
      createdBy: VALID_WALLET_ADDRESS,
      rematchOf: null,
      metadata: { label: `arena-${seq}` },
    });
  }

  withNetworkMismatch(): this {
    return this.with({ network: MAINNET_PASSPHRASE });
  }

  withInvalidContractId(): this {
    return this.with({ id: "INVALID_CONTRACT_ID" });
  }

  withMaxPlayersBoundary(): this {
    return this.with({ maxPlayers: MAX_ARENA_PLAYERS });
  }

  withMaxSizeMetadata(): this {
    return this.with({
      metadata: { blob: "x".repeat(MAX_METADATA_BYTES) },
    });
  }

  protected validate(value: ArenaFixture): string[] {
    const issues: string[] = [];
    if (!CONTRACT_ID_REGEX.test(value.id)) issues.push("id must be a valid Soroban contract ID");
    if (!WALLET_ADDRESS_REGEX.test(value.createdBy)) issues.push("createdBy must be a valid Stellar address");
    if (!value.network.trim()) issues.push("network must be non-empty");
    validatePositiveStroops(value.entryFeeStroops, "entryFeeStroops", issues);
    if (!Number.isInteger(value.maxPlayers) || value.maxPlayers < 2 || value.maxPlayers > MAX_ARENA_PLAYERS) {
      issues.push(`maxPlayers must be between 2 and ${MAX_ARENA_PLAYERS}`);
    }
    if (!Number.isInteger(value.roundNumber) || value.roundNumber < 0) {
      issues.push("roundNumber must be a non-negative integer");
    }
    if (value.rematchOf !== null && !CONTRACT_ID_REGEX.test(value.rematchOf)) {
      issues.push("rematchOf must be null or a valid Soroban contract ID");
    }
    return issues;
  }
}

export class RoundFixtureBuilder extends BaseFixtureBuilder<RoundFixture> {
  protected readonly domain = "Round";

  constructor(seq = nextSeq()) {
    super({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      id: `round-${seq}`,
      arenaId: VALID_CONTRACT_ID,
      network: TESTNET_PASSPHRASE,
      roundNumber: 1,
      state: "OPEN",
      deadlineLedger: 10_000 + seq,
      resolvedOutcome: null,
    });
  }

  withStaleLedger(): this {
    return this.with({ deadlineLedger: 1 });
  }

  protected validate(value: RoundFixture): string[] {
    const issues: string[] = [];
    if (!value.id.trim()) issues.push("id must be non-empty");
    if (!CONTRACT_ID_REGEX.test(value.arenaId)) issues.push("arenaId must be a valid Soroban contract ID");
    if (!Number.isInteger(value.roundNumber) || value.roundNumber < 1) {
      issues.push("roundNumber must be >= 1");
    }
    if (!Number.isInteger(value.deadlineLedger) || value.deadlineLedger < 1) {
      issues.push("deadlineLedger must be >= 1");
    }
    if ((value.state === "RESOLVED" || value.state === "SETTLED") && value.resolvedOutcome === null) {
      issues.push("resolvedOutcome is required when state is RESOLVED or SETTLED");
    }
    return issues;
  }
}

export class CommitmentFixtureBuilder extends BaseFixtureBuilder<CommitmentFixture> {
  protected readonly domain = "Commitment";

  constructor(seq = nextSeq()) {
    super({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      arenaId: VALID_CONTRACT_ID,
      roundNumber: 1,
      player: VALID_WALLET_ADDRESS,
      choice: 0,
      saltHex: seq.toString(16).padStart(64, "0"),
      commitmentHash: (seq + 1).toString(16).padStart(64, "a"),
      ledgerSequence: 10_000 + seq,
    });
  }

  protected validate(value: CommitmentFixture): string[] {
    const issues: string[] = [];
    if (!CONTRACT_ID_REGEX.test(value.arenaId)) issues.push("arenaId must be a valid Soroban contract ID");
    if (!WALLET_ADDRESS_REGEX.test(value.player)) issues.push("player must be a valid Stellar address");
    if (value.choice !== 0 && value.choice !== 1) issues.push("choice must be 0 or 1");
    if (!HEX_64_REGEX.test(value.saltHex)) issues.push("saltHex must be 64 hex chars");
    if (!HEX_64_REGEX.test(value.commitmentHash)) issues.push("commitmentHash must be 64 hex chars");
    return issues;
  }
}

export class TransactionFixtureBuilder extends BaseFixtureBuilder<TransactionFixture> {
  protected readonly domain = "Transaction";

  constructor(seq = nextSeq()) {
    super({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      id: `tx-${seq}`,
      payoutId: `payout-${seq}`,
      arenaId: VALID_CONTRACT_ID,
      roundNumber: 1,
      recipient: VALID_RECIPIENT_ADDRESS,
      amountStroops: "25000000",
      status: "queued",
      txHash: null,
      attempts: 0,
      network: TESTNET_PASSPHRASE,
    });
  }

  withDuplicatePayoutId(existingPayoutId: string): this {
    return this.with({ payoutId: existingPayoutId });
  }

  withZeroAmount(): this {
    return this.with({ amountStroops: "0" });
  }

  protected validate(value: TransactionFixture): string[] {
    const issues: string[] = [];
    if (!value.id.trim()) issues.push("id must be non-empty");
    if (!value.payoutId.trim()) issues.push("payoutId must be non-empty");
    if (!CONTRACT_ID_REGEX.test(value.arenaId)) issues.push("arenaId must be a valid Soroban contract ID");
    if (!WALLET_ADDRESS_REGEX.test(value.recipient)) issues.push("recipient must be a valid Stellar address");
    validatePositiveStroops(value.amountStroops, "amountStroops", issues);
    if (value.status === "confirmed" && (!value.txHash || !HEX_64_REGEX.test(value.txHash))) {
      issues.push("confirmed transaction must have a 64-char hex txHash");
    }
    if (!Number.isInteger(value.attempts) || value.attempts < 0) {
      issues.push("attempts must be a non-negative integer");
    }
    return issues;
  }
}

export class CompatibilityManifestFixtureBuilder extends BaseFixtureBuilder<CompatibilityManifestFixture> {
  protected readonly domain = "CompatibilityManifest";

  constructor() {
    super({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      network: TESTNET_PASSPHRASE,
      configRevision: 100,
      contracts: {
        arena: { version: "1.0.0" },
        factory: { version: "1.0.0" },
        payout: { version: "1.0.0" },
        staking: { version: "1.0.0" },
      },
      capabilities: {
        join: true,
        commit: true,
        reveal: true,
        claim: true,
        admin: true,
      },
    });
  }

  protected validate(value: CompatibilityManifestFixture): string[] {
    const issues: string[] = [];
    if (value.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
      issues.push(`schemaVersion must be ${FIXTURE_SCHEMA_VERSION}`);
    }
    if (!value.network.trim()) issues.push("network must be non-empty");
    if (!Number.isInteger(value.configRevision) || value.configRevision < 0) {
      issues.push("configRevision must be a non-negative integer");
    }
    return issues;
  }
}

export const buildArena = (seq?: number) => new ArenaFixtureBuilder(seq);
export const buildRound = (seq?: number) => new RoundFixtureBuilder(seq);
export const buildCommitment = (seq?: number) => new CommitmentFixtureBuilder(seq);
export const buildTransaction = (seq?: number) => new TransactionFixtureBuilder(seq);
export const buildCompatibilityManifest = () => new CompatibilityManifestFixtureBuilder();

/**
 * Executes a fixture builder or async seeder with bounded retries while recording
 * success, failure, retry, and latency metrics + structured logs.
 */
export async function buildFixtureWithRetry<T>(
  domain: string,
  fn: () => Promise<T> | T,
  options: {
    maxRetries?: number;
    metrics?: FixtureBuildMetrics;
    log?: (entry: FixtureLogEntry) => void;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  const metrics = options.metrics;
  const started = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      const value = await fn();
      const latencyMs = Date.now() - started;
      if (metrics) {
        metrics.success += 1;
        metrics.totalLatencyMs += latencyMs;
      }
      options.log?.({
        event: "fixture_build_success",
        domain,
        latencyMs,
        attempts,
      });
      return value;
    } catch (error) {
      if (attempts <= maxRetries) {
        if (metrics) metrics.retry += 1;
        options.log?.({
          event: "fixture_build_retry",
          domain,
          latencyMs: Date.now() - started,
          attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const latencyMs = Date.now() - started;
      if (metrics) {
        metrics.failure += 1;
        metrics.totalLatencyMs += latencyMs;
      }
      options.log?.({
        event: "fixture_build_failure",
        domain,
        latencyMs,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
