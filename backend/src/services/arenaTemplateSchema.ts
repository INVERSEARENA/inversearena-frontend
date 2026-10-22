/**
 * Versioned arena configuration templates (#1689).
 *
 * A template is a named, wallet-owned bundle of arena settings that a
 * creator can apply to the creation form. Two rules shape everything here:
 *
 *  1. A template stores *canonical* values, never display strings: the
 *     stake amount is a minor-unit integer string, the asset and the
 *     integrations are contract ids. "100 USDC" in a template would be
 *     ambiguous the moment the display precision changes.
 *
 *  2. A template is never trusted. Every save and every use revalidates it
 *     against the current protocol bounds, the current registry lifecycle
 *     and the current deployment capabilities, and reports what is wrong
 *     field by field. A template written against last month's bounds is
 *     stale, not invalid — it is reported with remediation so the creator
 *     can fix it deliberately.
 *
 * Schema versions are explicit. A payload from an older version is migrated
 * deterministically; a payload from a newer version is reported as
 * incompatible rather than silently rewritten, because rewriting creator
 * intent behind their back is worse than refusing.
 */

/** The current payload schema version. */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** Protocol bounds, mirroring the creator form's own limits. */
export const TEMPLATE_MIN_CAPACITY = 10;
export const TEMPLATE_MAX_CAPACITY = 1000;
/** Minimum stake, in whole units of the asset. */
export const TEMPLATE_MIN_STAKE = 10;

/** The round speeds the creation form offers. */
export const TEMPLATE_ROUND_SPEEDS = ["30S", "1M", "5M"] as const;
export type TemplateRoundSpeed = (typeof TEMPLATE_ROUND_SPEEDS)[number];

/** The canonical payload of a template. */
export interface ArenaTemplatePayload {
  /** Stake amount in the asset's minor units, as a decimal string. */
  stakeAmountMinor: string;
  /** Decimals of the stake asset, so the minor amount can be checked. */
  assetDecimals: number;
  /** The stake token's contract id. */
  asset: string;
  /** Arena capacity (maximum players). */
  capacity: number;
  /** The round schedule. */
  roundSpeed: TemplateRoundSpeed;
  /** Round duration in seconds. */
  roundDurationSeconds: number;
  /** How long after creation a round may be started, in seconds. */
  startDeadlineSeconds?: number;
  /** The yield vault's contract id. */
  yieldVault?: string;
  /** The oracle's contract id. */
  oracle?: string;
  /** Free-form metadata the creator attached. */
  metadata?: Record<string, string>;
}

/** One field-level problem with a template. */
export interface TemplateRemediation {
  /** The payload field the problem belongs to. */
  field: string;
  /** A stable machine-readable code. */
  code: string;
  /** What the creator has to do about it. */
  message: string;
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/**
 * Deterministic schema migrations (#1689).
 *
 * Each entry upgrades one version to the next. A template whose version is
 * not in the map is either migrated (older) or refused (newer) — it is
 * never rewritten by guesswork.
 */
const MIGRATIONS: Record<number, (payload: Record<string, unknown>) => Record<string, unknown>> = {
  // v0 → v1: the pre-versioning payload stored a display amount and a
  // currency code. v1 stores minor units and a contract id. The display
  // amount cannot be converted without knowing the asset's decimals, so the
  // migration only carries the fields that are unambiguous and leaves the
  // amount for the creator to confirm.
  0: (payload) => {
    const migrated = { ...payload };
    delete migrated.stakeAmount;
    delete migrated.currency;
    migrated.stakeAmountMinor = "";
    migrated.assetDecimals = 7;
    migrated.asset = "";
    return migrated;
  },
};

/**
 * Migrate a stored payload to the current schema version.
 *
 * Returns the migrated payload, or `null` when the payload's version cannot
 * be migrated — a version from the future, or an unknown one. The caller
 * reports that as an explicit incompatibility.
 */
export function migrateTemplatePayload(
  schemaVersion: number,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) return null;
  let current = payload;
  let version = schemaVersion;
  while (version < TEMPLATE_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) return null;
    current = migration(current);
    version += 1;
  }
  if (version > TEMPLATE_SCHEMA_VERSION) return null;
  return current;
}

/** The lifecycle state of an integration, as reported by the factory (#1688). */
export type IntegrationLifecycleState = "Active" | "Deprecated" | "Disabled";

export interface TemplateValidationContext {
  /** Lifecycle states keyed by `<kind>:<address>`. */
  lifecycle: Record<string, IntegrationLifecycleState>;
  /** The stake token the deployment is configured with, if any. */
  configuredAsset?: string | undefined;
  /** The yield vault the deployment is configured with, if any. */
  configuredVault?: string | undefined;
  /** The oracle the deployment is configured with, if any. */
  configuredOracle?: string | undefined;
}

function lifecycleOf(
  context: TemplateValidationContext,
  kind: "token" | "vault" | "oracle",
  address: string | undefined,
): IntegrationLifecycleState {
  if (!address) return "Active";
  return context.lifecycle[`${kind}:${address}`] ?? "Active";
}

/**
 * Validate a payload against the current protocol, registry and deployment.
 *
 * Every problem is reported; validation does not stop at the first one, so
 * the creator sees the whole list at once.
 */
export function validateTemplatePayload(
  payload: ArenaTemplatePayload,
  context: TemplateValidationContext,
): TemplateRemediation[] {
  const remediation: TemplateRemediation[] = [];

  // The stake amount is a canonical minor-unit amount.
  const minor = typeof payload.stakeAmountMinor === "string" ? payload.stakeAmountMinor.trim() : "";
  if (!/^\d+$/.test(minor) || minor === "0") {
    remediation.push({
      field: "stakeAmountMinor",
      code: "STAKE_AMOUNT_INVALID",
      message: "The stake amount must be a positive integer amount in the asset's minor units.",
    });
  } else if (Number.isInteger(payload.assetDecimals) && payload.assetDecimals >= 0) {
    const minimumMinor = TEMPLATE_MIN_STAKE * 10 ** payload.assetDecimals;
    if (BigInt(minor) < BigInt(minimumMinor)) {
      remediation.push({
        field: "stakeAmountMinor",
        code: "STAKE_BELOW_MINIMUM",
        message: `The stake amount must be at least ${TEMPLATE_MIN_STAKE} units of the asset.`,
      });
    }
  }

  if (!Number.isInteger(payload.capacity) || payload.capacity < TEMPLATE_MIN_CAPACITY || payload.capacity > TEMPLATE_MAX_CAPACITY) {
    remediation.push({
      field: "capacity",
      code: "CAPACITY_OUT_OF_RANGE",
      message: `The arena capacity must be between ${TEMPLATE_MIN_CAPACITY} and ${TEMPLATE_MAX_CAPACITY} players.`,
    });
  }

  if (!TEMPLATE_ROUND_SPEEDS.includes(payload.roundSpeed)) {
    remediation.push({
      field: "roundSpeed",
      code: "ROUND_SPEED_UNSUPPORTED",
      message: `The round speed must be one of ${TEMPLATE_ROUND_SPEEDS.join(", ")}.`,
    });
  }

  if (!Number.isInteger(payload.roundDurationSeconds) || payload.roundDurationSeconds <= 0) {
    remediation.push({
      field: "roundDurationSeconds",
      code: "ROUND_DURATION_INVALID",
      message: "The round duration must be a positive number of seconds.",
    });
  }

  if (payload.startDeadlineSeconds !== undefined && (!Number.isInteger(payload.startDeadlineSeconds) || payload.startDeadlineSeconds <= 0)) {
    remediation.push({
      field: "startDeadlineSeconds",
      code: "START_DEADLINE_INVALID",
      message: "The start deadline must be a positive number of seconds.",
    });
  }

  const integrations: Array<{
    field: string;
    kind: "token" | "vault" | "oracle";
    address: string | undefined;
    label: string;
    required: boolean;
  }> = [
    { field: "asset", kind: "token", address: payload.asset, label: "stake token", required: true },
    { field: "yieldVault", kind: "vault", address: payload.yieldVault, label: "yield vault", required: false },
    { field: "oracle", kind: "oracle", address: payload.oracle, label: "oracle", required: false },
  ];

  for (const integration of integrations) {
    if (!integration.address) {
      if (integration.required) {
        remediation.push({
          field: integration.field,
          code: "INTEGRATION_MISSING",
          message: `The ${integration.label} must be set.`,
        });
      }
      continue;
    }
    if (!CONTRACT_ID.test(integration.address)) {
      remediation.push({
        field: integration.field,
        code: "INTEGRATION_NOT_A_CONTRACT",
        message: `The ${integration.label} must be a Soroban contract id.`,
      });
      continue;
    }

    const state = lifecycleOf(context, integration.kind, integration.address);
    if (state === "Deprecated") {
      remediation.push({
        field: integration.field,
        code: `${integration.kind.toUpperCase()}_DEPRECATED`,
        message: `The ${integration.label} is deprecated: it still settles the arenas that use it, but no new arena can be created with it.`,
      });
    } else if (state === "Disabled") {
      remediation.push({
        field: integration.field,
        code: `${integration.kind.toUpperCase()}_DISABLED`,
        message: `The ${integration.label} has been withdrawn by the protocol and cannot be used for a new arena.`,
      });
    }
  }

  // Deployment capability: the integrations a template names must be the ones
  // the deployment is actually configured with.
  const capability = [
    { field: "asset", configured: context.configuredAsset, address: payload.asset, label: "stake token" },
    { field: "yieldVault", configured: context.configuredVault, address: payload.yieldVault, label: "yield vault" },
    { field: "oracle", configured: context.configuredOracle, address: payload.oracle, label: "oracle" },
  ];
  for (const check of capability) {
    if (!check.configured || !check.address) continue;
    if (check.configured !== check.address) {
      remediation.push({
        field: check.field,
        code: "INTEGRATION_NOT_CONFIGURED",
        message: `The ${check.label} in this template is not the one this deployment is configured with.`,
      });
    }
  }

  return remediation;
}
