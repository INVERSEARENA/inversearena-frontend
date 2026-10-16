/**
 * Canonical versioned asset descriptor and exact amount codec (#1521).
 *
 * Asset identity previously travelled as a bare `code` string plus an optional
 * `issuer`, with decimals looked up by code from a global table. That makes
 * equivalent assets compare differently (same code, different issuer/contract),
 * lets a display symbol stand in for identity in transaction builders, and
 * repeats amount scaling — often through `number` — at every call site.
 *
 * This module defines a single, versioned descriptor that carries network,
 * kind (native vs issued), code, issuer, SAC contract id, and decimals, plus an
 * exact integer-minor-unit codec with an explicit rounding policy. All
 * arithmetic is `bigint`; floating-point conversion is rejected.
 *
 * The module is pure (no SDK/IO imports) so it is unit testable in isolation
 * and can back both protocol config and API schemas.
 */

/** Bump when the descriptor shape changes in a non-backward-compatible way. */
export const ASSET_DESCRIPTOR_SCHEMA_VERSION = 1 as const;

/** Maximum decimals Stellar amounts are accepted at in this codec. */
export const MAX_ASSET_DECIMALS = 18;

/** Signed 128-bit max — the width the arena contracts store amounts in. */
export const MAX_I128 = (1n << 127n) - 1n;

export type AssetKind = "native" | "issued";

export type RoundingPolicy = "reject" | "floor" | "ceil" | "halfUp" | "halfEven";

export interface AssetDescriptor {
  /** Descriptor schema version; additive API schema version (#1521). */
  schemaVersion: typeof ASSET_DESCRIPTOR_SCHEMA_VERSION;
  kind: AssetKind;
  /** Asset code; `XLM` for the native asset. */
  code: string;
  /** Issuer account; `null` for the native asset, required for issued. */
  issuer: string | null;
  /** Stellar Asset Contract id when known; `null` for native pre-SAC. */
  contractId: string | null;
  /** Storage decimals (minor units per whole unit = 10**decimals). */
  decimals: number;
  /** Canonical network passphrase this descriptor is valid on. */
  network: string;
}

export class AssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetValidationError";
  }
}

export class AmbiguousLegacyAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousLegacyAssetError";
  }
}

export class RoundingRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoundingRequiredError";
  }
}

export class AmountOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountOverflowError";
  }
}

const CODE_RE = /^[A-Z0-9]{1,12}$/;
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

/**
 * Validate and normalise an asset descriptor. Rejects ambiguous or internally
 * inconsistent descriptors (e.g. native with an issuer, issued without one,
 * decimals out of range, malformed contract/issuer).
 */
export function validateAssetDescriptor(input: AssetDescriptor): AssetDescriptor {
  const issues: string[] = [];

  if (input.schemaVersion !== ASSET_DESCRIPTOR_SCHEMA_VERSION) {
    issues.push(`unsupported schemaVersion ${String(input.schemaVersion)}`);
  }
  if (input.kind !== "native" && input.kind !== "issued") {
    issues.push(`invalid kind ${String(input.kind)}`);
  }
  if (!CODE_RE.test(input.code)) {
    issues.push(`invalid code ${String(input.code)}`);
  }
  if (
    !Number.isInteger(input.decimals) ||
    input.decimals < 0 ||
    input.decimals > MAX_ASSET_DECIMALS
  ) {
    issues.push(`decimals must be an integer in [0, ${MAX_ASSET_DECIMALS}]`);
  }
  if (typeof input.network !== "string" || input.network.trim() === "") {
    issues.push("network passphrase is required");
  }

  if (input.kind === "native") {
    if (input.issuer !== null) {
      issues.push("native asset must not carry an issuer");
    }
    if (input.code !== "XLM") {
      issues.push("native asset code must be XLM");
    }
    if (input.contractId !== null && !CONTRACT_RE.test(input.contractId)) {
      issues.push("native contractId must be a valid contract id or null");
    }
  } else {
    // An issued asset is anchored by either its issuer account (classic) or
    // its Stellar Asset Contract id (SAC-first deployments), or both. At least
    // one must be present or identity is ambiguous (#1521).
    if (input.issuer === null && input.contractId === null) {
      issues.push("issued asset requires an issuer or a contract id");
    }
    if (input.issuer !== null && !ACCOUNT_RE.test(input.issuer)) {
      issues.push("issued asset issuer must be a valid account id");
    }
    if (input.contractId !== null && !CONTRACT_RE.test(input.contractId)) {
      issues.push("issued asset contractId must be a valid contract id or null");
    }
  }

  if (issues.length > 0) {
    throw new AssetValidationError(
      `Invalid asset descriptor for ${input.code}: ${issues.join("; ")}`,
    );
  }
  return { ...input };
}

export function makeDescriptor(
  input: Omit<AssetDescriptor, "schemaVersion"> &
    Partial<Pick<AssetDescriptor, "schemaVersion">>,
): AssetDescriptor {
  return validateAssetDescriptor({
    schemaVersion: ASSET_DESCRIPTOR_SCHEMA_VERSION,
    ...input,
  } as AssetDescriptor);
}

/** Canonical, collision-free identity key for equality and de-duplication. */
export function assetIdentityKey(d: AssetDescriptor): string {
  return [
    "v" + d.schemaVersion,
    d.network,
    d.kind,
    d.code,
    d.issuer ?? "-",
    d.contractId ?? "-",
    "d" + d.decimals,
  ].join(":");
}

/**
 * True only when two descriptors describe the *same* asset on the same network
 * with the same storage decimals. Display symbols are deliberately ignored.
 */
export function assetsEqual(a: AssetDescriptor, b: AssetDescriptor): boolean {
  return assetIdentityKey(validateAssetDescriptor(a)) === assetIdentityKey(validateAssetDescriptor(b));
}

/** Legacy shapes handed to the compatibility adapter. */
export interface LegacyAssetInput {
  code?: string | null;
  issuer?: string | null;
  contractId?: string | null;
  decimals?: number | null;
  network?: string | null;
  /** Display symbol; accepted only to be *rejected* as an identity source. */
  symbol?: string | null;
}

export interface LegacyAssetMigrationInfo {
  /** Which legacy field combination triggered the adapter. */
  legacyForm: "code_only" | "code_issuer" | "code_contract" | "symbol_only";
  code: string;
}

/**
 * Best-effort bridge from legacy asset shapes to a validated descriptor
 * (#1521). Rejects ambiguous input rather than guessing identity, and reports
 * what it migrated through a caller-supplied sink so a legacy field that is
 * still in use becomes visible instead of silently accepted.
 *
 * Ambiguity cases rejected on purpose:
 *  - a display `symbol` is not an identity (code vs symbol collision);
 *  - an issued asset (non-XLM) with no issuer and no contract id;
 *  - conflicting issuer and contract id that disagree on nothing verifiable.
 */
export function adaptLegacyAsset(
  input: LegacyAssetInput,
  onMigration?: (info: LegacyAssetMigrationInfo) => void,
): AssetDescriptor {
  const code = (input.code ?? "").trim().toUpperCase();
  const issuer = input.issuer?.trim() || null;
  const contractId = input.contractId?.trim() || null;
  const network = input.network?.trim();

  if (!code && input.symbol) {
    throw new AmbiguousLegacyAssetError(
      `Cannot derive asset identity from display symbol '${input.symbol}': a code is required`,
    );
  }
  if (!network) {
    throw new AmbiguousLegacyAssetError(
      `Cannot derive asset identity for '${code}' without an explicit network`,
    );
  }

  if (code === "XLM") {
    if (issuer) {
      throw new AmbiguousLegacyAssetError(
        "Native XLM must not carry an issuer; issuer was set",
      );
    }
    const descriptor = makeDescriptor({
      kind: "native",
      code,
      issuer: null,
      contractId,
      decimals: input.decimals ?? 7,
      network,
    });
    onMigration?.({ legacyForm: "code_only", code });
    return descriptor;
  }

  if (!issuer && !contractId) {
    throw new AmbiguousLegacyAssetError(
      `Issued asset '${code}' is ambiguous: neither issuer nor contract id provided`,
    );
  }

  const decimals = input.decimals;
  if (decimals === null || decimals === undefined) {
    throw new AmbiguousLegacyAssetError(
      `Issued asset '${code}' is ambiguous: decimals must be explicit`,
    );
  }

  const descriptor = makeDescriptor({
    kind: "issued",
    code,
    issuer,
    contractId,
    decimals,
    network,
  });
  onMigration?.({
    legacyForm: issuer ? "code_issuer" : "code_contract",
    code,
  });
  return descriptor;
}

interface ParsedDecimal {
  negative: boolean;
  intDigits: string;
  fracDigits: string;
}

function parseDecimalString(amount: string): ParsedDecimal {
  const trimmed = amount.trim();
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!m) {
    throw new AssetValidationError(`Not a valid decimal amount: '${amount}'`);
  }
  return {
    negative: m[1] === "-",
    intDigits: m[2]!,
    fracDigits: m[3] ?? "",
  };
}

function isAllZeros(s: string): boolean {
  for (const ch of s) if (ch !== "0") return false;
  return true;
}

/**
 * Convert a decimal string to integer minor units using an explicit rounding
 * policy. `number` inputs are intentionally not accepted — a float cannot
 * represent minor units exactly, so callers must pass a string or bigint.
 */
export function toMinorUnits(
  amount: string | bigint,
  decimals: number,
  policy: RoundingPolicy,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
    throw new AssetValidationError(`decimals must be in [0, ${MAX_ASSET_DECIMALS}]`);
  }
  if (typeof amount === "bigint") {
    // A bigint is already an exact whole amount; scale it exactly.
    const scaled = amount * 10n ** BigInt(decimals);
    assertInRange(scaled);
    return scaled;
  }
  if (typeof amount !== "string") {
    throw new AssetValidationError(
      "Floating-point monetary conversion is prohibited; pass a decimal string or bigint",
    );
  }

  const { negative, intDigits, fracDigits } = parseDecimalString(amount);
  const keptFrac = fracDigits.slice(0, decimals).padEnd(decimals, "0");
  const remainder = fracDigits.slice(decimals);
  let magnitude = BigInt(intDigits + keptFrac);

  if (remainder.length > 0 && !isAllZeros(remainder)) {
    switch (policy) {
      case "reject":
        throw new RoundingRequiredError(
          `Amount '${amount}' has more than ${decimals} decimal places; rounding policy is 'reject'`,
        );
      case "floor":
        if (negative) magnitude += 1n;
        break;
      case "ceil":
        if (!negative) magnitude += 1n;
        break;
      case "halfUp":
        if (remainder[0]! >= "5") magnitude += 1n;
        break;
      case "halfEven": {
        const half = "5" + "0".repeat(remainder.length - 1);
        if (remainder > half) magnitude += 1n;
        else if (remainder === half && magnitude % 2n === 1n) magnitude += 1n;
        break;
      }
    }
  }

  const signed = negative ? -magnitude : magnitude;
  assertInRange(signed);
  return signed;
}

/**
 * Format integer minor units back to an exact decimal string. Never rounds:
 * the full storage precision is preserved (`trimTrailingZeros` is a display
 * convenience only and does not affect a stored value).
 */
export function fromMinorUnits(
  atomic: bigint,
  decimals: number,
  options: { trimTrailingZeros?: boolean } = {},
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
    throw new AssetValidationError(`decimals must be in [0, ${MAX_ASSET_DECIMALS}]`);
  }
  const negative = atomic < 0n;
  const magnitude = negative ? -atomic : atomic;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const frac = magnitude % divisor;

  if (decimals === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  let fracStr = frac.toString().padStart(decimals, "0");
  if (options.trimTrailingZeros) {
    fracStr = fracStr.replace(/0+$/, "");
  }
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return `${negative ? "-" : ""}${body}`;
}

function assertInRange(value: bigint): void {
  if (value > MAX_I128 || value < -MAX_I128) {
    throw new AmountOverflowError(
      `Amount ${value.toString()} exceeds the signed 128-bit range`,
    );
  }
}
