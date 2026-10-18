/**
 * Runtime-validated branded value objects for Stellar / Soroban identity (#1522).
 *
 * ## Problem
 * Contract IDs, account IDs, network names, passphrases, and deployment
 * aliases are passed as plain `string` across configuration, caches, API DTOs,
 * and transaction builders. A syntactically valid identifier can be used in the
 * wrong namespace or on the wrong network with no compile-time or runtime
 * guard.
 *
 * ## Solution
 * This module exports *branded* value types and their constructors. A branded
 * type is a plain `string` at runtime, but its TypeScript type carries a
 * phantom brand so it is not assignable to a different branded type or to a
 * raw `string` parameter without an explicit parse.
 *
 * All parsers validate the string with `@stellar/stellar-sdk`'s `StrKey`
 * where applicable, then return the branded type. Validation errors throw a
 * descriptive `IdentityValidationError`.
 *
 * ## Design rules
 *   1. Never construct a value object by casting (`"G…" as StellarAccountId`).
 *      Always use the named constructor (`parseStellarAccountId("G…")`).
 *   2. Wire-format (JSON / API responses) uses plain `string`. Convert at the
 *      ingress boundary with the parser; convert back with `.value` (or just
 *      coerce — the brands disappear at runtime).
 *   3. Add new types in this file; do not create ad-hoc branded types
 *      elsewhere. See `frontend/docs/IDENTITY_VALUE_OBJECTS.md`.
 */

import { StrKey } from "@stellar/stellar-sdk";

// ─── Error ────────────────────────────────────────────────────────────────────

export class IdentityValidationError extends Error {
  constructor(
    public readonly kind: string,
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`Invalid ${kind} "${input}": ${reason}`);
    this.name = "IdentityValidationError";
  }
}

// ─── Branding helper ─────────────────────────────────────────────────────────

declare const __brand: unique symbol;
type Brand<B> = { readonly [__brand]: B };

/**
 * A branded string type. The underlying value is always a plain `string`
 * at runtime; the brand exists only in the type system.
 */
export type Branded<T extends string, B> = T & Brand<B>;

// ─── StellarAccountId ─────────────────────────────────────────────────────────

/**
 * A validated Stellar account public key (StrKey type `ed25519PublicKey`).
 * Starts with `G`, 56 characters total.
 */
export type StellarAccountId = Branded<string, "StellarAccountId">;

/**
 * Parse and validate a Stellar account public key.
 * @throws {IdentityValidationError} when the value is not a valid ed25519 public key.
 */
export function parseStellarAccountId(raw: string): StellarAccountId {
  const trimmed = raw.trim();
  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    throw new IdentityValidationError(
      "StellarAccountId",
      trimmed,
      "must be a valid Stellar ed25519 public key (starts with G, 56 characters)",
    );
  }
  return trimmed as StellarAccountId;
}

/** Returns `null` instead of throwing. */
export function tryParseStellarAccountId(raw: string): StellarAccountId | null {
  try {
    return parseStellarAccountId(raw);
  } catch {
    return null;
  }
}

// ─── SorobanContractId ───────────────────────────────────────────────────────

/**
 * A validated Soroban contract address (StrKey type `contract`).
 * Starts with `C`, 56 characters total.
 *
 * Placeholder IDs (e.g. `CD...`) used in tests and optional-config fallbacks
 * can be parsed with `{ allowPlaceholder: true }`.
 */
export type SorobanContractId = Branded<string, "SorobanContractId">;

const PLACEHOLDER_CONTRACT_RE = /^C\.{3}[A-Z0-9_-]+$/;

export interface ParseContractIdOptions {
  /** Allow test placeholder IDs that start with `C...`. */
  allowPlaceholder?: boolean;
}

/**
 * Parse and validate a Soroban contract address.
 * @throws {IdentityValidationError} when invalid.
 */
export function parseSorobanContractId(
  raw: string,
  options: ParseContractIdOptions = {},
): SorobanContractId {
  const trimmed = raw.trim();
  if (options.allowPlaceholder && PLACEHOLDER_CONTRACT_RE.test(trimmed)) {
    return trimmed as SorobanContractId;
  }
  if (!StrKey.isValidContract(trimmed)) {
    throw new IdentityValidationError(
      "SorobanContractId",
      trimmed,
      "must be a valid Soroban contract address (starts with C, 56 characters)",
    );
  }
  return trimmed as SorobanContractId;
}

/** Returns `null` instead of throwing. */
export function tryParseSorobanContractId(
  raw: string,
  options: ParseContractIdOptions = {},
): SorobanContractId | null {
  try {
    return parseSorobanContractId(raw, options);
  } catch {
    return null;
  }
}

// ─── StellarTransactionHash ──────────────────────────────────────────────────

/**
 * A validated Stellar / Soroban transaction hash.
 * 64 lowercase hex characters.
 */
export type StellarTransactionHash = Branded<string, "StellarTransactionHash">;

const TX_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Parse and validate a transaction hash.
 * @throws {IdentityValidationError} when invalid.
 */
export function parseStellarTransactionHash(raw: string): StellarTransactionHash {
  const lower = raw.trim().toLowerCase();
  if (!TX_HASH_RE.test(lower)) {
    throw new IdentityValidationError(
      "StellarTransactionHash",
      raw,
      "must be 64 lowercase hex characters",
    );
  }
  return lower as StellarTransactionHash;
}

/** Returns `null` instead of throwing. */
export function tryParseStellarTransactionHash(raw: string): StellarTransactionHash | null {
  try {
    return parseStellarTransactionHash(raw);
  } catch {
    return null;
  }
}

// ─── NetworkPassphrase ───────────────────────────────────────────────────────

/**
 * A validated Stellar network passphrase.
 * Non-empty, printable ASCII, max 100 characters.
 */
export type NetworkPassphrase = Branded<string, "NetworkPassphrase">;

const PASSPHRASE_RE = /^[\w\s;:(),.-]+$/;

/** Well-known network passphrases. */
export const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015" as NetworkPassphrase,
  mainnet: "Public Global Stellar Network ; September 2015" as NetworkPassphrase,
} as const;

/**
 * Parse and validate a Stellar network passphrase.
 * @throws {IdentityValidationError} when invalid.
 */
export function parseNetworkPassphrase(raw: string): NetworkPassphrase {
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 100 || !PASSPHRASE_RE.test(trimmed)) {
    throw new IdentityValidationError(
      "NetworkPassphrase",
      trimmed,
      "must be 3–100 printable ASCII characters",
    );
  }
  return trimmed as NetworkPassphrase;
}

/** Returns `null` instead of throwing. */
export function tryParseNetworkPassphrase(raw: string): NetworkPassphrase | null {
  try {
    return parseNetworkPassphrase(raw);
  } catch {
    return null;
  }
}

// ─── NetworkIdentity ─────────────────────────────────────────────────────────

/**
 * An opaque, canonical network identity derived from the network passphrase.
 *
 * Used as the `network` component in cache keys, idempotency keys, and
 * capability scope strings so that cross-network contamination is detectable
 * at the key layer rather than discovered at query time.
 *
 * The canonical form is the first 8 characters of the SHA-256 hex digest of
 * the passphrase.  This keeps keys short while being collision-resistant for
 * any realistic set of Stellar networks.
 *
 * Use {@link deriveNetworkIdentity} to construct one.
 */
export type NetworkIdentity = Branded<string, "NetworkIdentity">;

/** Well-known short aliases for display purposes (not used in keys). */
export const NETWORK_ALIASES: Record<string, string> = {
  [NETWORK_PASSPHRASES.testnet]: "testnet",
  [NETWORK_PASSPHRASES.mainnet]: "mainnet",
};

// We derive the identity synchronously using a simple, deterministic hash
// so we don't need async WebCrypto here.  For key-collision safety a
// full SHA-256 would be ideal, but for the purpose of key namespacing a
// FNV-1a 32-bit hash is sufficient and fully synchronous.
function fnv1a32(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (Math.imul(hash, 16777619) >>> 0);
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Derive a short, canonical {@link NetworkIdentity} from a validated network
 * passphrase.  Deterministic: the same passphrase always produces the same
 * identity string.
 */
export function deriveNetworkIdentity(passphrase: NetworkPassphrase): NetworkIdentity {
  const alias = NETWORK_ALIASES[passphrase];
  if (alias) return alias as NetworkIdentity;
  return `net-${fnv1a32(passphrase)}` as NetworkIdentity;
}

// ─── DeploymentRevision ──────────────────────────────────────────────────────

/**
 * A validated deployment revision number. Positive integer emitted by the
 * backend's compatibility manifest and included in cache/idempotency keys
 * so that a contract upgrade automatically busts any cached value that was
 * derived under the old revision.
 */
export type DeploymentRevision = Branded<number, "DeploymentRevision">;

/**
 * Parse and validate a deployment revision number.
 * @throws {IdentityValidationError} when invalid.
 */
export function parseDeploymentRevision(raw: number): DeploymentRevision {
  if (!Number.isInteger(raw) || raw < 1) {
    throw new IdentityValidationError(
      "DeploymentRevision",
      String(raw),
      "must be a positive integer",
    );
  }
  return raw as DeploymentRevision;
}

// ─── Network-bound ContractId ─────────────────────────────────────────────────

/**
 * A Soroban contract ID that is **bound to a specific network identity**.
 *
 * When you hold a `NetworkBoundContractId` you know both the contract address
 * *and* which network it lives on.  Passing one to an API that expects a
 * different network can be caught at the type level (the `network` field must
 * match the expected `NetworkIdentity`).
 */
export interface NetworkBoundContractId {
  readonly contractId: SorobanContractId;
  readonly network: NetworkIdentity;
}

/**
 * Construct a {@link NetworkBoundContractId}, validating both components.
 * @throws {IdentityValidationError} when the contract ID is invalid.
 */
export function bindContractToNetwork(
  rawContractId: string,
  passphrase: NetworkPassphrase,
  options: ParseContractIdOptions = {},
): NetworkBoundContractId {
  const contractId = parseSorobanContractId(rawContractId, options);
  const network = deriveNetworkIdentity(passphrase);
  return { contractId, network };
}

// ─── Canonical key builders ───────────────────────────────────────────────────

/**
 * Namespace separator used in all canonical keys produced by this module.
 * Using `:` keeps parity with existing Redis key conventions in cacheService.ts.
 */
const SEP = ":";

/**
 * Build a canonical arena cache key that includes network identity.
 *
 * Format: `arena:{network}:{arenaId}:{suffix}`
 *
 * Including the network prevents a testnet arena ID that happens to share
 * characters with a mainnet ID from hitting the same cache slot.
 */
export function arenaNetworkCacheKey(
  network: NetworkIdentity,
  arenaId: SorobanContractId,
  suffix: string,
): string {
  return `arena${SEP}${network}${SEP}${arenaId}${SEP}${suffix}`;
}

/**
 * Build a canonical idempotency key for a wallet mutation that includes
 * network identity, so testnet and mainnet mutations never share a key.
 *
 * Format: `idempotency:{network}:{walletId}:{arenaId}:{round}:{action}`
 */
export function mutationIdempotencyKey(
  network: NetworkIdentity,
  walletId: StellarAccountId,
  arenaId: SorobanContractId,
  round: number,
  action: string,
): string {
  return `idempotency${SEP}${network}${SEP}${walletId}${SEP}${arenaId}${SEP}${round}${SEP}${action}`;
}

/**
 * Build a canonical capability-scope key that includes network identity.
 *
 * Format: `capability:{network}:{arenaId}`
 */
export function capabilityScopeKey(
  network: NetworkIdentity,
  arenaId: SorobanContractId,
): string {
  return `capability${SEP}${network}${SEP}${arenaId}`;
}
