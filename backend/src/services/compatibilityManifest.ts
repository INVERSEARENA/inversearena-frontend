/**
 * Versioned client compatibility manifest (#1491).
 *
 * Compatibility used to be decided only inside backend services
 * (contractCapability.ts, #1409), so a frontend could offer an action whose
 * required contract entrypoint a particular deployment does not have and only
 * find out after the user signed. This module turns validated protocol config
 * plus capability negotiation into a client-facing decision: which named
 * client capabilities (join, commit, reveal, claim, admin) this deployment
 * supports, tagged with the network, the ledger it was derived at
 * (`configRevision`) and each contract instance's negotiated version.
 *
 * Failure semantics: a contract whose version cannot be read is reported as
 * `unavailable` and every capability that needs a version check against it is
 * `unsupported` with reason `negotiation_failed` - the manifest never guesses
 * support. A capability whose entrypoints have no version requirement (the
 * capability map ships empty) stays `supported` even when negotiation fails,
 * because nothing depends on the version.
 */
import { getStellarConfig } from "../config/stellarConfig";
import {
  getRequiredCapabilityVersion,
  negotiateCapability,
  type ContractKind,
} from "./contractCapability";
import { getCurrentLedgerSequence } from "./ledgerClock";

export const COMPATIBILITY_MANIFEST_SCHEMA_VERSION = 1 as const;

export type ClientCapability = "join" | "commit" | "reveal" | "claim" | "admin";

/**
 * Contract entrypoints each client capability needs. A capability is
 * supported only when every listed entrypoint is.
 */
export const CLIENT_CAPABILITY_REQUIREMENTS: Record<
  ClientCapability,
  ReadonlyArray<{ kind: ContractKind; entrypoint: string }>
> = {
  join: [{ kind: "arena", entrypoint: "join_arena" }],
  commit: [{ kind: "arena", entrypoint: "submit_commitment" }],
  reveal: [{ kind: "arena", entrypoint: "reveal_choice" }],
  claim: [{ kind: "arena", entrypoint: "claim" }],
  admin: [
    { kind: "arena", entrypoint: "start_round" },
    { kind: "arena", entrypoint: "resolve_round" },
    { kind: "arena", entrypoint: "cancel_arena" },
  ],
};

export interface CompatibilityManifestDeps {
  networkPassphrase: () => string;
  configRevision: () => Promise<number>;
  negotiate: (kind: ContractKind, contractId: string) => Promise<number>;
  requiredVersion: (kind: ContractKind, entrypoint: string) => number | undefined;
  factoryContractId: () => string | undefined;
  payoutContractId: () => string | undefined;
  now: () => Date;
}

const defaultDeps: CompatibilityManifestDeps = {
  networkPassphrase: () => getStellarConfig().networkPassphrase,
  configRevision: getCurrentLedgerSequence,
  negotiate: negotiateCapability,
  requiredVersion: getRequiredCapabilityVersion,
  factoryContractId: () => process.env.ARENA_FACTORY_CONTRACT_ID || undefined,
  payoutContractId: () => process.env.PAYOUT_CONTRACT_ID || undefined,
  now: () => new Date(),
};

interface Capability {
  status: "supported" | "unsupported" | "unknown";
  reason?: "contract_version" | "negotiation_failed" | "contract_not_specified";
  requiredVersion?: number;
}

interface ContractEntry {
  kind: ContractKind;
  contractId: string;
  version: number | null;
  status: "negotiated" | "unavailable";
}

export interface CompatibilityManifest {
  schemaVersion: typeof COMPATIBILITY_MANIFEST_SCHEMA_VERSION;
  network: { passphrase: string };
  /** Ledger sequence the manifest was derived at. */
  configRevision: number;
  generatedAt: string;
  contracts: ContractEntry[];
  capabilities: Record<string, Capability>;
}

function evaluateCapability(
  name: ClientCapability,
  contracts: ReadonlyMap<ContractKind, ContractEntry>,
  requiredVersion: CompatibilityManifestDeps["requiredVersion"],
): Capability {
  let unknown = false;

  for (const requirement of CLIENT_CAPABILITY_REQUIREMENTS[name]) {
    const required = requiredVersion(requirement.kind, requirement.entrypoint);
    // No version requirement: available since the contract's first version.
    if (required === undefined) continue;

    const contract = contracts.get(requirement.kind);
    if (!contract) {
      unknown = true;
      continue;
    }
    if (contract.status === "unavailable" || contract.version === null) {
      return { status: "unsupported", reason: "negotiation_failed", requiredVersion: required };
    }
    if (contract.version < required) {
      return { status: "unsupported", reason: "contract_version", requiredVersion: required };
    }
  }

  return unknown
    ? { status: "unknown", reason: "contract_not_specified" }
    : { status: "supported" };
}

export async function buildCompatibilityManifest(
  input: { arenaId?: string } = {},
  overrides: Partial<CompatibilityManifestDeps> = {},
): Promise<CompatibilityManifest> {
  const deps = { ...defaultDeps, ...overrides };

  const instances: Array<{ kind: ContractKind; contractId: string }> = [];
  if (input.arenaId) instances.push({ kind: "arena", contractId: input.arenaId });
  const factory = deps.factoryContractId();
  if (factory) instances.push({ kind: "factory", contractId: factory });
  const payout = deps.payoutContractId();
  if (payout) instances.push({ kind: "payout", contractId: payout });

  const [configRevision, negotiated] = await Promise.all([
    deps.configRevision(),
    Promise.all(
      instances.map(async ({ kind, contractId }): Promise<ContractEntry> => {
        try {
          return { kind, contractId, version: await deps.negotiate(kind, contractId), status: "negotiated" };
        } catch {
          return { kind, contractId, version: null, status: "unavailable" };
        }
      }),
    ),
  ]);

  const byKind = new Map<ContractKind, ContractEntry>(negotiated.map((entry) => [entry.kind, entry]));
  const capabilities: Record<string, Capability> = {};
  for (const name of Object.keys(CLIENT_CAPABILITY_REQUIREMENTS) as ClientCapability[]) {
    capabilities[name] = evaluateCapability(name, byKind, deps.requiredVersion);
  }

  return {
    schemaVersion: COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
    network: { passphrase: deps.networkPassphrase() },
    configRevision,
    generatedAt: deps.now().toISOString(),
    contracts: negotiated,
    capabilities,
  };
}
