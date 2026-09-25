/**
 * Shared ledger continuity detector (#1490).
 *
 * Arena snapshots, transaction reconciliation and SSE event cursors all
 * assume ledger progress is monotonic. RPC failover or an upstream rollback
 * can break that: a previously observed (sequence, hash) pair stops being
 * canonical while cached, derived arena state built from it stays visible.
 *
 * This module keeps a bounded window of observed ledger identities
 * (sequence + hash) and classifies every new observation against it:
 *
 *   initial    first observation, nothing to compare against
 *   advanced   newer sequence, within the retained window
 *   unchanged  same sequence and hash as the latest observation
 *   lagging    older sequence whose hash matches a retained entry - a slow
 *              RPC endpoint, not a rollback; ignored
 *   regression older sequence with no matching retained entry -> rollback
 *   conflict   sequence we retained with a different hash    -> rollback
 *   gap        sequence further ahead than the retained window can vouch
 *              for; continuity cannot be verified, window is re-anchored
 *
 * A rollback opens a recovery: reads are quarantined (isQuarantined()), the
 * window is truncated back to the last verified common point (the highest
 * retained entry below the observed sequence) and registered consumers are
 * told to invalidate what they derived. Recovery completes once
 * `recoveryConfirmations` further observations advance consistently from the
 * re-anchored window. The state is optionally persisted through a
 * ContinuityStore so a restart during recovery stays quarantined.
 */
import { logger } from "../utils/logger";
import { cache, arenaDerivedCachePatterns, cacheKeys, cacheTTL } from "../cache/cacheService";
import {
  ledgerRollbackAffectedConsumersTotal,
  ledgerRollbackDepth,
  ledgerRollbackRecoveryDuration,
} from "../utils/metrics";
import { setLedgerObserver } from "./ledgerClock";

export interface LedgerIdentity {
  sequence: number;
  hash: string;
}

export type ContinuityOutcome =
  | "initial"
  | "advanced"
  | "unchanged"
  | "lagging"
  | "regression"
  | "conflict"
  | "gap";

export interface RecoveryState {
  /** Epoch milliseconds of the first detection in this recovery. */
  startedAt: number;
  trigger: "regression" | "conflict";
  /** Highest identity observed before the rollback. */
  previousLatest: LedgerIdentity;
  /** The identity that exposed the rollback. */
  observed: LedgerIdentity;
  /** Last verified common point, or null when it fell outside the retained window. */
  checkpoint: LedgerIdentity | null;
  depth: number;
  /** Consistent advancing observations seen since detection. */
  confirmations: number;
}

export interface ContinuityState {
  window: LedgerIdentity[];
  recovery: RecoveryState | null;
  /** Incremented on every rollback or gap; consumers compare it to know their derived state predates one. */
  epoch: number;
}

export interface ContinuityStore {
  load(): Promise<ContinuityState | null>;
  save(state: ContinuityState): Promise<void>;
}

export type ContinuityEventKind = "rollback" | "gap" | "recovered";

export interface ContinuityEvent {
  kind: ContinuityEventKind;
  epoch: number;
  checkpoint: LedgerIdentity | null;
  depth: number;
}

export type ContinuityConsumer = (event: ContinuityEvent) => Promise<void> | void;

export interface ObserveResult {
  outcome: ContinuityOutcome;
  quarantined: boolean;
  epoch: number;
  recovered: boolean;
}

export interface LedgerContinuityOptions {
  store?: ContinuityStore;
  /** Max retained identities, and the largest forward jump still treated as continuous. */
  windowSize?: number;
  /** Consistent advancing observations required to end a recovery. */
  recoveryConfirmations?: number;
  now?: () => number;
}

export const DEFAULT_LEDGER_WINDOW_SIZE = 128;
export const DEFAULT_RECOVERY_CONFIRMATIONS = 2;

function emptyState(): ContinuityState {
  return { window: [], recovery: null, epoch: 0 };
}

function isIdentity(value: unknown): value is LedgerIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sequence === "number" &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence > 0 &&
    typeof candidate.hash === "string" &&
    candidate.hash.length > 0
  );
}

function isPersistedState(value: unknown): value is ContinuityState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.window) &&
    candidate.window.every(isIdentity) &&
    typeof candidate.epoch === "number" &&
    Number.isSafeInteger(candidate.epoch) &&
    (candidate.recovery === null || typeof candidate.recovery === "object")
  );
}

export class LedgerContinuity {
  private state: ContinuityState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly consumers = new Map<string, ContinuityConsumer>();
  private readonly windowSize: number;
  private readonly recoveryConfirmations: number;
  private readonly now: () => number;
  private readonly store: ContinuityStore | undefined;

  constructor(options: LedgerContinuityOptions = {}) {
    this.store = options.store;
    this.windowSize = options.windowSize ?? DEFAULT_LEDGER_WINDOW_SIZE;
    this.recoveryConfirmations = options.recoveryConfirmations ?? DEFAULT_RECOVERY_CONFIRMATIONS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.windowSize) || this.windowSize < 2) {
      throw new Error("Ledger continuity window must be an integer of at least 2");
    }
    if (!Number.isInteger(this.recoveryConfirmations) || this.recoveryConfirmations < 1) {
      throw new Error("Ledger continuity recovery confirmations must be a positive integer");
    }
  }

  /** Register a consumer told about rollbacks/gaps (to invalidate) and recoveries (to re-baseline). */
  registerConsumer(name: string, handler: ContinuityConsumer): void {
    this.consumers.set(name, handler);
  }

  /** True while rollback recovery is active; consumers must not publish newer state. */
  isQuarantined(): boolean {
    return this.state.recovery !== null;
  }

  getEpoch(): number {
    return this.state.epoch;
  }

  getStatus(): { quarantined: boolean; epoch: number; checkpoint: LedgerIdentity | null; latest: LedgerIdentity | null } {
    const recovery = this.state.recovery;
    return {
      quarantined: recovery !== null,
      epoch: this.state.epoch,
      checkpoint: recovery?.checkpoint ?? null,
      latest: this.state.window.at(-1) ?? null,
    };
  }

  /** Load persisted state (a restart during recovery must stay quarantined). */
  async hydrate(): Promise<void> {
    await this.serialize(() => this.reload());
  }

  observe(identity: LedgerIdentity): Promise<ObserveResult> {
    if (!isIdentity(identity)) {
      return Promise.reject(new TypeError("Ledger identity needs a positive integer sequence and a non-empty hash"));
    }
    return this.serialize(() => this.apply({ sequence: identity.sequence, hash: identity.hash }));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reload(): Promise<void> {
    if (!this.store) return;
    const stored = await this.store.load();
    if (stored && isPersistedState(stored)) {
      this.state = { window: stored.window, recovery: stored.recovery, epoch: stored.epoch };
    }
  }

  private classify(identity: LedgerIdentity): ContinuityOutcome {
    const window = this.state.window;
    const latest = window.at(-1);
    if (!latest) return "initial";

    const known = window.find((entry) => entry.sequence === identity.sequence);
    if (known) {
      if (known.hash !== identity.hash) return "conflict";
      return identity.sequence === latest.sequence ? "unchanged" : "lagging";
    }
    if (identity.sequence > latest.sequence) {
      return identity.sequence - latest.sequence > this.windowSize ? "gap" : "advanced";
    }
    return "regression";
  }

  private append(identity: LedgerIdentity): void {
    const window = this.state.window;
    window.push(identity);
    if (window.length > this.windowSize) {
      window.splice(0, window.length - this.windowSize);
    }
  }

  private async apply(identity: LedgerIdentity): Promise<ObserveResult> {
    await this.reload();
    const state = this.state;
    const outcome = this.classify(identity);
    const events: ContinuityEvent[] = [];
    let recovered = false;

    switch (outcome) {
      case "initial":
        state.window = [identity];
        break;
      case "advanced":
        this.append(identity);
        if (state.recovery) {
          state.recovery.confirmations += 1;
          recovered = state.recovery.confirmations >= this.recoveryConfirmations;
        }
        break;
      case "unchanged":
      case "lagging":
        break;
      case "gap":
        state.window = [identity];
        state.epoch += 1;
        if (state.recovery) state.recovery.confirmations = 0;
        logger.warn(
          { event: "ledger_continuity_gap", observedSequence: identity.sequence, epoch: state.epoch },
          "Ledger jumped beyond the retained window; continuity cannot be verified",
        );
        events.push({ kind: "gap", epoch: state.epoch, checkpoint: null, depth: 0 });
        break;
      case "regression":
      case "conflict":
        events.push(this.enterRecovery(outcome, identity));
        break;
    }

    if (recovered && state.recovery) {
      const recovery = state.recovery;
      const seconds = Math.max(0, (this.now() - recovery.startedAt) / 1000);
      state.recovery = null;
      ledgerRollbackRecoveryDuration.observe(seconds);
      logger.info(
        {
          event: "ledger_rollback_recovered",
          durationSeconds: seconds,
          depth: recovery.depth,
          checkpointSequence: recovery.checkpoint?.sequence ?? null,
          resumedAtSequence: identity.sequence,
          epoch: state.epoch,
        },
        "Ledger continuity re-verified; publishing resumes",
      );
      events.push({ kind: "recovered", epoch: state.epoch, checkpoint: recovery.checkpoint, depth: recovery.depth });
    }

    if (this.store) {
      await this.store.save({ window: state.window, recovery: state.recovery, epoch: state.epoch });
    }
    await this.notify(events);

    return { outcome, quarantined: state.recovery !== null, epoch: state.epoch, recovered };
  }

  private enterRecovery(trigger: "regression" | "conflict", identity: LedgerIdentity): ContinuityEvent {
    const state = this.state;
    const previousLatest = state.window.at(-1)!;
    const kept = state.window.filter((entry) => entry.sequence < identity.sequence);
    const checkpoint = kept.at(-1) ?? null;
    const depth = previousLatest.sequence - identity.sequence + 1;

    state.window = [...kept, identity];
    state.epoch += 1;
    const existing = state.recovery;
    state.recovery = {
      startedAt: existing?.startedAt ?? this.now(),
      trigger,
      previousLatest: existing && existing.previousLatest.sequence > previousLatest.sequence ? existing.previousLatest : previousLatest,
      observed: identity,
      checkpoint,
      depth: Math.max(existing?.depth ?? 0, depth),
      confirmations: 0,
    };

    ledgerRollbackDepth.observe(depth);
    logger.warn(
      {
        event: "ledger_rollback_detected",
        trigger,
        previousLatestSequence: previousLatest.sequence,
        observedSequence: identity.sequence,
        checkpointSequence: checkpoint?.sequence ?? null,
        beyondRetention: checkpoint === null,
        depth,
        epoch: state.epoch,
      },
      "Ledger rollback detected; derived arena state is quarantined",
    );
    return { kind: "rollback", epoch: state.epoch, checkpoint, depth: state.recovery.depth };
  }

  private async notify(events: ContinuityEvent[]): Promise<void> {
    for (const event of events) {
      const affected: string[] = [];
      for (const [name, handler] of this.consumers) {
        try {
          await handler(event);
          if (event.kind !== "recovered") {
            affected.push(name);
            ledgerRollbackAffectedConsumersTotal.inc({ consumer: name });
          }
        } catch (error) {
          logger.error(
            {
              event: "ledger_continuity_consumer_failed",
              consumer: name,
              kind: event.kind,
              errorName: error instanceof Error ? error.name : typeof error,
            },
            "Ledger continuity consumer failed to handle event",
          );
        }
      }
      if (event.kind !== "recovered") {
        logger.warn(
          { event: "ledger_rollback_consumers_notified", kind: event.kind, affectedConsumers: affected },
          "Ledger continuity consumers notified",
        );
      }
    }
  }
}

/**
 * Process-wide handle consumers use to honour recovery. Until
 * initLedgerContinuity() installs the real detector it never quarantines, so
 * behaviour is unchanged.
 */
let active: LedgerContinuity | null = null;

export function getRollbackGuard(): { isQuarantined(): boolean; getEpoch(): number } {
  return active ?? { isQuarantined: () => false, getEpoch: () => 0 };
}

/** Test seam. */
export function setLedgerContinuityForTest(next: LedgerContinuity | null): void {
  active = next;
}

/**
 * Startup wiring: Redis-backed state (so a restart during recovery stays
 * quarantined), arena cache invalidation on rollback/gap and again on
 * recovery, and installation as the ledger observer.
 */
export async function initLedgerContinuity(
  network: string = process.env.STELLAR_NETWORK_PASSPHRASE ?? "default",
): Promise<LedgerContinuity> {
  const key = cacheKeys.ledgerContinuity(network);
  const continuity = new LedgerContinuity({
    store: {
      load: () => cache.get<ContinuityState>(key),
      save: (state) => cache.set(key, state, cacheTTL.LEDGER_CONTINUITY),
    },
  });
  continuity.registerConsumer("arena-cache", async () => {
    for (const pattern of arenaDerivedCachePatterns) await cache.delByPattern(pattern);
  });
  await continuity.hydrate();
  active = continuity;
  setLedgerObserver((identity) => continuity.observe(identity));
  return continuity;
}
