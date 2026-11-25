/**
 * Dry-run command for the storage TTL keeper (#1516).
 *
 * Prints a machine-readable plan of which contract storage keys are inside the
 * renewal window, so an operator can review targets — and the cost/scope of a
 * renewal — before enabling the scheduled keeper. It never submits a
 * transaction: `runTtlKeeper` is called with `dryRun: true`.
 *
 * Usage:
 *   TTL_KEEPER_MANIFESTS='[{"contractId":"C...","kind":"staking","network":"...","version":2}]' \
 *     npm run ttl:plan
 *
 * Exit code is 0 when a plan was produced (even an empty one), 1 when the
 * manifests are misconfigured or the chain could not be read.
 *
 * @module
 */

import { Command } from "commander";
import { logger } from "../utils/logger";
import {
  manifestsFromEnv,
  DEFAULT_TTL_KEEPER_POLICY,
  type TtlKeeperPolicy,
} from "../services/ttlKeeperPlan";
import { runTtlKeeper, summarizeRun } from "../services/ttlKeeperService";
import { createRpcTtlReader } from "../services/onChainTtlReader";
import {
  getOnChainContractVersion,
  readOnChainStorageInventory,
} from "../services/onChainReader";
import { hasReadValue } from "../types/onChainRead";
import { env, processEnv } from "../config/env";

function policyFromEnv(env: NodeJS.ProcessEnv): TtlKeeperPolicy {
  const num = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`expected a non-negative integer, received ${value}`);
    }
    return parsed;
  };
  return {
    renewBelowLedgers: num(env.TTL_KEEPER_RENEW_BELOW_LEDGERS, DEFAULT_TTL_KEEPER_POLICY.renewBelowLedgers),
    maxRenewalsPerRun: num(env.TTL_KEEPER_MAX_RENEWALS_PER_RUN, DEFAULT_TTL_KEEPER_POLICY.maxRenewalsPerRun),
    maxRenewalsPerContract: num(
      env.TTL_KEEPER_MAX_RENEWALS_PER_CONTRACT,
      DEFAULT_TTL_KEEPER_POLICY.maxRenewalsPerContract,
    ),
  };
}

export async function buildDryRunPlan() {
  const manifests = manifestsFromEnv(env.TTL_KEEPER_MANIFESTS);
  const policy = policyFromEnv(processEnv);

  return runTtlKeeper({
    reader: createRpcTtlReader(),
    manifests,
    policy,
    dryRun: true,
    readVersion: async (contractId) => {
      try {
        return await getOnChainContractVersion(contractId);
      } catch {
        return null;
      }
    },
    readInventory: async (contractId) => {
      const result = await readOnChainStorageInventory(contractId);
      if (!hasReadValue(result)) return [];
      return result.value.map((item) => ({ key: item.key, present: item.present }));
    },
    renew: async () => {
      throw new Error("dry-run must not submit renewals");
    },
  });
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("ttl:plan")
    .description("Print a machine-readable contract storage TTL renewal plan (dry-run only)");
  program.parse(process.argv);

  const run = await buildDryRunPlan();
  process.stdout.write(`${JSON.stringify(summarizeRun(run), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(
      { event: "ttl_keeper_plan_failed", error: error instanceof Error ? error.message : String(error) },
      "ttl keeper dry-run failed",
    );
    process.exitCode = 1;
  });
}
