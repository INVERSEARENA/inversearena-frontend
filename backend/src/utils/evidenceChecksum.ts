import { createHash } from 'crypto';
import { EVIDENCE_PACKAGE_SCHEMA_VERSION, type DisputeEvidencePackage } from '../types/evidence';

/**
 * Canonical, deterministic JSON stringify: object keys sorted recursively so
 * the same logical package always hashes to the same checksum regardless of
 * property insertion order. Mirrors
 * `services/roundProofBundleService.ts`'s `canonicalStringify` — kept as a
 * separate copy here (rather than a shared import) because this one backs a
 * correctness-critical contract shared with the standalone support verifier
 * script (`scripts/verify-evidence-package.ts`), which must never drift from
 * whatever `roundProofBundleService.ts` does for its own, unrelated bundle.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}

/** Computes the checksum for a package payload that does not yet carry a `checksum` field. */
export function computeEvidenceChecksum(packageWithoutChecksum: Omit<DisputeEvidencePackage, 'checksum'>): string {
  return createHash('sha256').update(canonicalStringify(packageWithoutChecksum)).digest('hex');
}

export type EvidenceVerificationFailureReason =
  | 'SCHEMA_VERSION_UNKNOWN'
  | 'CHECKSUM_MISMATCH'
  | 'MALFORMED_PACKAGE';

export interface EvidenceVerificationResult {
  valid: boolean;
  /** Present only when `valid` is false. */
  reason?: EvidenceVerificationFailureReason;
  detail?: string;
  schemaVersion?: number;
}

/**
 * Support-facing offline integrity check (#1517 acceptance criteria: "A
 * checksum and schema version allow offline integrity validation"). Pure and
 * requires no database or RPC access — see docs/DISPUTE_EVIDENCE_RUNBOOK.md.
 *
 * Deliberately does not attempt to "upgrade" or partially trust a package
 * from an unrecognized schema version — a verifier that guesses at an
 * unknown shape is worse than one that refuses outright (mirrors
 * `RoundProofBundleUnavailableError`'s "never synthesize a degraded read"
 * principle in roundProofBundleService.ts).
 */
export function verifyEvidencePackage(candidate: unknown): EvidenceVerificationResult {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    typeof (candidate as Record<string, unknown>).checksum !== 'string' ||
    typeof (candidate as Record<string, unknown>).schemaVersion !== 'number'
  ) {
    return { valid: false, reason: 'MALFORMED_PACKAGE', detail: 'Not a recognizable evidence package object' };
  }

  const pkg = candidate as Record<string, unknown> & { checksum: string; schemaVersion: number };

  if (pkg.schemaVersion !== EVIDENCE_PACKAGE_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: 'SCHEMA_VERSION_UNKNOWN',
      detail: `Verifier supports schemaVersion ${EVIDENCE_PACKAGE_SCHEMA_VERSION}; package reports ${pkg.schemaVersion}`,
      schemaVersion: pkg.schemaVersion,
    };
  }

  const { checksum, ...withoutChecksum } = pkg;
  const recomputed = createHash('sha256').update(canonicalStringify(withoutChecksum)).digest('hex');

  if (recomputed !== checksum) {
    return {
      valid: false,
      reason: 'CHECKSUM_MISMATCH',
      detail: `Recomputed checksum ${recomputed} does not match declared checksum ${checksum}`,
      schemaVersion: pkg.schemaVersion,
    };
  }

  return { valid: true, schemaVersion: pkg.schemaVersion };
}
