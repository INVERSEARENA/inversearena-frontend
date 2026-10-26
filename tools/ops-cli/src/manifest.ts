/**
 * Deployment manifest (#1462) loading: the CLI takes its network, RPC URL and
 * contract ids from contract/deployment-manifest.json, never from call sites.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type NetworkName = "testnet" | "mainnet" | "standalone";

export const NETWORK_PASSPHRASES: Record<NetworkName, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  standalone: "Standalone Network ; February 2017",
};

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/** Contract kinds the CLI addresses, with the manifest keys it accepts for each. */
export const CONTRACT_KINDS = {
  factory: ["factory"],
  oracle: ["oracle"],
  vault: ["rwa_adapter", "rwa-adapter", "vault"],
  staking: ["staking"],
  payout: ["payout"],
} as const;

export type ContractKind = keyof typeof CONTRACT_KINDS;

export interface Deployment {
  /** Where the manifest was read from, for messages. */
  source: string;
  network: NetworkName;
  networkPassphrase: string;
  rpcUrl: string;
  /** Contract id per manifest key. */
  contracts: Record<string, string>;
  /** Keys whose id is malformed: an error only when that contract is used. */
  invalid: string[];
}

export class ManifestError extends Error {
  override name = "ManifestError";
}

/** Validate a parsed manifest; collect every problem rather than the first. */
export function parseManifest(data: unknown, source: string): Deployment {
  const errors: string[] = [];
  const m = (data ?? {}) as Record<string, unknown>;
  if (m.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${String(m.schemaVersion)})`);

  const network = m.network as NetworkName;
  if (!(network in NETWORK_PASSPHRASES)) {
    errors.push(`network must be testnet, mainnet or standalone (got ${String(m.network)})`);
  } else if (m.networkPassphrase !== NETWORK_PASSPHRASES[network]) {
    errors.push(`networkPassphrase does not match network "${network}"`);
  }
  if (typeof m.rpcUrl !== "string" || !/^https?:\/\//.test(m.rpcUrl)) errors.push("rpcUrl must be an http(s) URL");

  // Network fields are always fatal: they decide where a transaction goes.
  // A malformed contract entry only matters to commands that use it, so one
  // bad id does not take every other command down during an incident.
  const contracts: Record<string, string> = {};
  const invalid: string[] = [];
  const entries = m.contracts && typeof m.contracts === "object" ? Object.entries(m.contracts) : [];
  if (entries.length === 0) errors.push("contracts must list at least one contract");
  for (const [key, entry] of entries) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && CONTRACT_ID.test(id)) contracts[key] = id;
    else invalid.push(key);
  }

  if (errors.length > 0) throw new ManifestError(`Invalid deployment manifest ${source}:\n  - ${errors.join("\n  - ")}`);
  return { source, network, networkPassphrase: m.networkPassphrase as string, rpcUrl: m.rpcUrl as string, contracts, invalid };
}

/** contract/deployment-manifest.json in the nearest ancestor that has one. */
export function findDefaultManifest(from: string = process.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "contract", "deployment-manifest.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadManifest(path: string): Deployment {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ManifestError(`Cannot read deployment manifest ${path}`);
  }
  try {
    return parseManifest(JSON.parse(raw), path);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError(`Deployment manifest ${path} is not valid JSON`);
  }
}

/**
 * The id of a contract kind: an explicit override wins, then the manifest.
 * The override is validated too, so a typo fails here and not at the RPC.
 */
export function contractIdFor(deployment: Deployment, kind: ContractKind, override?: string): string {
  if (override !== undefined) {
    if (!CONTRACT_ID.test(override)) throw new ManifestError(`--${kind} must be a contract id (C...)`);
    return override;
  }
  for (const key of CONTRACT_KINDS[kind]) {
    const id = deployment.contracts[key];
    if (id) return id;
    if (deployment.invalid.includes(key)) {
      throw new ManifestError(`contracts.${key}.id in ${deployment.source} is not a valid contract id (C...). Fix it or pass --${kind} <C...>.`);
    }
  }
  throw new ManifestError(
    `No ${kind} contract in ${deployment.source} (keys: ${CONTRACT_KINDS[kind].join(", ")}). Pass --${kind} <C...>.`,
  );
}

export const isContractId = (value: string) => CONTRACT_ID.test(value);
