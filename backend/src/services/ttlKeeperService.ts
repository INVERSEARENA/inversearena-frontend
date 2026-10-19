/**
 * Storage TTL keeper (#1516).
 *
 * Orchestrates one keeper run: read the observed chain state for each
 * manifest-declared contract, ask the pure planner what should be renewed, and
 * submit bounded, idempotent renewals — recording submitted/confirmed/failed
 * status and emitting metrics.
 *
 * Every side-effecting dependency is injected (`reader`, `readVersion`,
 * `readInventory`, `renew`) so the scheduling/status logic is unit tested with
 * fakes and only the CLI wires in real RPC.
 *
 * Safety properties:
 * - **Bounded.** Only `plan.renew` contracts are touched, already capped by the
 *   policy. A mass-expiry event cannot become an unbounded burst.
 * - **Idempotent.** `renew_storage` extends only entries inside the threshold,
 *   so a duplicate or restarted worker re-running an already-renewed contract
 *   is a no-op on-chain.
 * - **Fail closed.** Identity is checked by the planner; a contract the keeper
 *   cannot positively identify is never renewed.
 *
 * @module
 */

import { logger } from "../utils/logger";
import {
  ttlKeeperConfirmationLagSeconds,
  ttlKeeperHeadroomLedgers,
  ttlKeeperIdentifyFailuresTotal,
  ttlKeeperRenewalsTotal,
} from "../utils/metrics";
import {
  planRenewals,
  type DeploymentManifest,
  type RenewalPlan,
  type TtlContractObservation,
  type TtlKeeperPolicy,
  type TtlKeyObservation,
} from "./ttlKeeperPlan";
import type { RpcTtlReader } from "./onChainTtlReader";

export interface TtlKeeperDeps {
  reader: RpcTtlReader;
  manifests: readonly DeploymentManifest[];
  policy: TtlKeeperPolicy;
  /** Read the deployed contract's `version()`, or null when unreadable. */
  readVersion(contractId: string): Promise<number | null>;
  /** Read the contract's critical-key inventory (`storage_inventory`). */
  readInventory(contractId: string): Promise<Array<{ key: string; present: boolean }>>;
  /** Submit a `renew_storage` transaction; reject on failure. */
  renew(contractId: string): Promise<void>;
  /**
   * When true, plan and publish metrics but never call `renew`. Used by the
   * dry-run command so operators can inspect targets before enabling the
   * scheduler.
   */
  dryRun?: boolean;
  now?: () => Date;
}

export interface RenewalResult {
  contractId: string;
  status: "confirmed" | "failed";
  /** Keys that motivated this renewal (from the plan). */
  keys: string[];
  lagSeconds: number | null;
  error?: string;
}

export interface TtlKeeperRun {
  currentLedger: number;
  observedNetwork: string;
  plan: RenewalPlan;
  results: RenewalResult[];
}

async function observeContract(
  deps: TtlKeeperDeps,
  manifest: DeploymentManifest,
  observedNetwork: string,
): Promise<TtlContractObservation> {
  const observedVersion = await deps
    .readVersion(manifest.contractId)
    .catch(() => null);

  let keys: TtlKeyObservation[] = [];
  try {
    const inventory = await deps.readInventory(manifest.contractId);
    keys = await Promise.all(
      inventory.map(async (item) => {
        if (!item.present) {
          return { key: item.key, present: false, liveUntilLedger: null };
        }
        const ttl = await deps.reader
          .getKeyTtl(manifest.contractId, item.key)
          .catch(() => ({ present: true, liveUntilLedger: null }));
        return {
          key: item.key,
          present: item.present,
          liveUntilLedger: ttl.liveUntilLedger,
        };
      }),
    );
  } catch (error) {
    logger.warn(
      {
        event: "ttl_keeper_inventory_unreadable",
        contractId: manifest.contractId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ttl keeper could not read contract storage inventory",
    );
    keys = [];
  }

  return {
    contractId: manifest.contractId,
    contractKind: manifest.kind,
    manifestNetwork: manifest.network,
    manifestVersion: manifest.version,
    observedNetwork,
    observedVersion,
    keys,
  };
}

/**
 * Run one keeper pass. Returns the plan and the per-contract renewal results.
 * The caller (scheduler / CLI) decides cadence; this function never schedules
 * itself, so it is safe to invoke from a dry-run.
 */
export async function runTtlKeeper(deps: TtlKeeperDeps): Promise<TtlKeeperRun> {
  const now = deps.now ?? (() => new Date());
  const currentLedger = await deps.reader.getLatestLedger();
  const observedNetwork = await deps.reader.getNetworkPassphrase();

  const observations: TtlContractObservation[] = [];
  for (const manifest of deps.manifests) {
    observations.push(await observeContract(deps, manifest, observedNetwork));
  }

  const plan = planRenewals(observations, { currentLedger, policy: deps.policy });

  // Publish headroom for every observed key (unreadable => -1) so alerting can
  // fire on the minimum even before a renewal is due.
  for (const observation of observations) {
    for (const key of observation.keys) {
      const headroom =
        key.liveUntilLedger === null ? -1 : key.liveUntilLedger - currentLedger;
      ttlKeeperHeadroomLedgers.set(
        { contract: observation.contractId, key: key.key },
        headroom,
      );
    }
  }

  // Identity failures are the "we deliberately did nothing" signal.
  for (const skipped of plan.skip) {
    if (
      skipped.reason === "identity_uncertain" ||
      skipped.reason === "network_mismatch" ||
      skipped.reason === "version_mismatch"
    ) {
      ttlKeeperIdentifyFailuresTotal.inc({
        contract: skipped.contractId,
        reason: skipped.reason,
      });
    }
  }

  // renew_storage is contract-wide, so collapse per-key targets to one renewal
  // per contract, preserving the planner's urgency order.
  const keysByContract = new Map<string, string[]>();
  const orderByContract: string[] = [];
  for (const target of plan.renew) {
    if (!keysByContract.has(target.contractId)) {
      keysByContract.set(target.contractId, []);
      orderByContract.push(target.contractId);
    }
    keysByContract.get(target.contractId)!.push(target.key);
  }

  if (deps.dryRun) {
    logger.info(
      { event: "ttl_keeper_dry_run", renew: plan.renew.length, skip: plan.skip.length },
      "ttl keeper dry-run: no renewals submitted",
    );
    return { currentLedger, observedNetwork, plan, results: [] };
  }

  const results: RenewalResult[] = [];
  for (const contractId of orderByContract) {
    const keys = keysByContract.get(contractId)!;
    const submittedAt = now();
    ttlKeeperRenewalsTotal.inc({ contract: contractId, status: "submitted", reason: "" });
    try {
      await deps.renew(contractId);
      const lagSeconds = Math.max(
        0,
        (now().getTime() - submittedAt.getTime()) / 1000,
      );
      ttlKeeperRenewalsTotal.inc({ contract: contractId, status: "confirmed", reason: "" });
      ttlKeeperConfirmationLagSeconds.observe({ contract: contractId }, lagSeconds);
      results.push({ contractId, status: "confirmed", keys, lagSeconds });
      logger.info(
        { event: "ttl_keeper_renewal_confirmed", contractId, keys, lagSeconds },
        "ttl keeper renewal confirmed",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ttlKeeperRenewalsTotal.inc({ contract: contractId, status: "failed", reason: "renew_error" });
      results.push({ contractId, status: "failed", keys, lagSeconds: null, error: message });
      logger.error(
        { event: "ttl_keeper_renewal_failed", contractId, keys, error: message },
        "ttl keeper renewal failed",
      );
    }
  }

  return { currentLedger, observedNetwork, plan, results };
}

/**
 * Machine-readable summary for the dry-run command. Deliberately carries no
 * transaction bytes or RPC payloads — just the plan.
 */
export function summarizeRun(run: TtlKeeperRun) {
  return {
    currentLedger: run.currentLedger,
    observedNetwork: run.observedNetwork,
    policy: run.plan.policy,
    renew: run.plan.renew,
    skip: run.plan.skip,
    results: run.results,
  };
}
