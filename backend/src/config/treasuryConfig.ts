import { z } from "zod";

/**
 * Versioned protocol treasury configuration (#1511).
 *
 * There is no on-chain treasury/fee-destination concept today — `claim()`
 * (`contract/arena/src/lib.rs`) transfers the full principal+yield to the
 * winner in one transfer; the protocol platform fee
 * (`ArenaConfig.platform_fee_bps`) is accounting metadata only and is never
 * actually deducted or moved anywhere on-chain (see
 * `backend/docs/TREASURY_RECONCILIATION_DESIGN.md` §1). `TREASURY_DESTINATION`
 * therefore names the address the protocol *expects* fees to eventually be
 * collected to, once fee collection is wired up — reconciliation reports
 * against that expectation rather than inventing one silently.
 *
 * `version` is bumped whenever this config's *shape* changes (a new field,
 * a removed field) — not on every value change. Each `TreasuryFeeRecord`
 * stores the `configVersion` it was computed under, so a later config change
 * never silently reinterprets an already-reconciled historical record.
 */
export const TREASURY_CONFIG_VERSION = 1 as const;

const TreasuryEnvSchema = z.object({
  TREASURY_DESTINATION: z.string().trim().min(1).optional(),
  // How long to wait after a ledger closes before treating a missing
  // transfer as a real discrepancy rather than "not yet finalized" (#1511
  // edge case: late events / reorgs). Generous default — Soroban RPC's
  // finality window plus operational slack.
  TREASURY_FINALITY_GRACE_SECONDS: z
    .string()
    .optional()
    .transform((v) => Number(v ?? "120"))
    .pipe(z.number().int().positive()),
});

export interface TreasuryConfig {
  version: typeof TREASURY_CONFIG_VERSION;
  /** Expected fee-collection destination address, or null if not yet configured
   * (every nonzero-fee record reconciles as a typed gap, not silently skipped). */
  treasuryDestination: string | null;
  finalityGraceSeconds: number;
}

export function getTreasuryConfig(env: NodeJS.ProcessEnv = process.env): TreasuryConfig {
  const parsed = TreasuryEnvSchema.parse({
    TREASURY_DESTINATION: env.TREASURY_DESTINATION,
    TREASURY_FINALITY_GRACE_SECONDS: env.TREASURY_FINALITY_GRACE_SECONDS,
  });

  return {
    version: TREASURY_CONFIG_VERSION,
    treasuryDestination: parsed.TREASURY_DESTINATION ?? null,
    finalityGraceSeconds: parsed.TREASURY_FINALITY_GRACE_SECONDS,
  };
}
