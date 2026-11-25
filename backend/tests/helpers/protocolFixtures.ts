/**
 * Backend test adapter for repository-wide protocol fixture builders (#1464).
 */
import lifecycleSpec from "../contract-fixtures/lifecycle-transitions.json";
import {
  buildArena,
  buildCommitment,
  buildCompatibilityManifest,
  buildFixtureWithRetry,
  buildRound,
  buildTransaction,
  FixtureValidationError,
  resetFixtureSequenceForTest,
  type ArenaFixture,
  type CommitmentFixture,
  type CompatibilityManifestFixture,
  type FixtureBuildMetrics,
  type FixtureLogEntry,
  type RoundFixture,
  type TransactionFixture,
} from "../../../frontend/src/shared/lib/testing/protocolFixtures";
import type { TransactionRecord } from "../../src/types/payment";

export {
  buildArena,
  buildCommitment,
  buildCompatibilityManifest,
  buildFixtureWithRetry,
  buildRound,
  buildTransaction,
  FixtureValidationError,
  resetFixtureSequenceForTest,
};

export type {
  ArenaFixture,
  CommitmentFixture,
  CompatibilityManifestFixture,
  FixtureBuildMetrics,
  FixtureLogEntry,
  RoundFixture,
  TransactionFixture,
};

export type LifecycleDomain = keyof typeof lifecycleSpec.domains;

/**
 * Checks whether a state transition is permitted by the canonical
 * `lifecycle-transitions.json` contract fixture.
 */
export function isAllowedLifecycleTransition(
  domain: LifecycleDomain,
  from: string,
  to: string,
): boolean {
  const entry = lifecycleSpec.domains[domain];
  if (!entry) return false;
  return entry.transitions.some(
    ([src, dst, allowed]) => src === from && dst === to && allowed === true,
  );
}

/**
 * Builds a backend `TransactionRecord` from the canonical `TransactionFixture`.
 */
export function buildBackendTransactionRecord(
  overrides: Partial<TransactionFixture> & { userWallet?: string } = {},
): TransactionRecord {
  const { userWallet, ...txOverrides } = overrides;
  const tx = buildTransaction().with(txOverrides).build();
  const now = new Date();
  return {
    id: tx.id,
    payoutId: tx.payoutId,
    arenaId: tx.arenaId,
    roundNumber: tx.roundNumber,
    userWallet: userWallet ?? tx.recipient,
    amount: Number(tx.amountStroops) / 10_000_000,
    status: tx.status as TransactionRecord["status"],
    txHash: tx.txHash ?? undefined,
    attempts: tx.attempts,
    createdAt: now,
    updatedAt: now,
  };
}
