/**
 * Rematch pools (#1572) — client side.
 *
 * The backend derives a rematch's prefill from the source arena's canonical
 * on-chain `PoolConfig`, not from whatever the browser happens to have cached,
 * so this module only fetches that view and maps it onto the pool-creation
 * form. It also records the rematch linkage after `create_pool` confirms.
 */
import { stellarConfig } from "@/shared/config/stellarConfig";
import type { Currency } from "@/shared/lib/form-validation";
import type { RoundSpeed } from "./pool-schema";

export type RematchBlockedReason =
  | "SOURCE_CONFIG_UNAVAILABLE"
  | "SOURCE_ARENA_NOT_FINISHED"
  | "STAKE_TOKEN_NOT_SUPPORTED"
  | "YIELD_VAULT_NOT_APPROVED"
  | "ORACLE_NOT_APPROVED"
  | "HOST_ACTIVE_POOL_LIMIT";

export interface RematchPrefillConfig {
  stakeToken: string;
  yieldVault: string;
  /** i128 entry fee, rendered as a decimal string. */
  entryFee: string;
  oracleContract: string;
  minPlayers: number;
  maxPlayers: number;
  /** Recorded round duration in seconds (0/absent before the first round). */
  roundDuration: number;
}

export interface RematchConfig {
  arenaId: string;
  available: boolean;
  blockedReason: RematchBlockedReason | null;
  blockedMessage: string | null;
  host: string;
  poolId: number;
  factoryContractId: string;
  isPriorParticipant: boolean;
  config: RematchPrefillConfig | null;
}

export class RematchConfigError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RematchConfigError";
  }
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Reads the source arena's rematch prefill. 404 means the arena is unknown;
 * 503 means its on-chain config could not be read. Both are expected answers
 * for a finished arena whose deployment drifted, not programming errors.
 */
export async function fetchRematchConfig(arenaId: string): Promise<RematchConfig> {
  const response = await fetch(
    `/api/arenas/${encodeURIComponent(arenaId)}/rematch-config`,
    { headers: authHeaders(), cache: "no-store" },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new RematchConfigError(
      response.status,
      body?.message ?? `Rematch configuration request failed (${response.status})`,
    );
  }

  return (await response.json()) as RematchConfig;
}

/** Maps the canonical 7-decimal token amount to a form-friendly number. */
export function entryFeeToStakeAmount(entryFee: string): string {
  const units = Number(entryFee);
  if (!Number.isFinite(units) || units <= 0) return "";
  const amount = units / 10_000_000;
  // Trim trailing zeros without forcing a fixed precision on the input.
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(7).replace(/0+$/, "");
}

export function roundDurationToSpeed(seconds: number): RoundSpeed {
  if (seconds <= 30) return "30S";
  if (seconds <= 60) return "1M";
  return "5M";
}

/** Which of the two supported currencies the arena staked, if recognisable. */
export function currencyForStakeToken(stakeToken: string): Currency | null {
  if (stakeToken === stellarConfig.usdcContractId) return "USDC";
  if (stakeToken === stellarConfig.xlmContractId) return "XLM";
  return null;
}

export interface RematchFormPrefill {
  stakeAmountInput: string;
  currency: Currency | null;
  roundSpeed: RoundSpeed;
  arenaCapacity: number;
}

/**
 * Converts the on-chain config into the pool-creation form's shape. Returns
 * `null` when the arena cannot be rematched or its stake token is not one the
 * form can offer (an unsupported token is a blocked reason on the backend, so
 * this is only a defensive fallback).
 */
export function toRematchFormPrefill(config: RematchConfig): RematchFormPrefill | null {
  if (!config.available || !config.config) return null;
  return {
    stakeAmountInput: entryFeeToStakeAmount(config.config.entryFee),
    currency: currencyForStakeToken(config.config.stakeToken),
    roundSpeed: roundDurationToSpeed(config.config.roundDuration),
    arenaCapacity: config.config.maxPlayers,
  };
}

export interface RecordRematchInput {
  txHash: string;
  rematchOf: string;
  sourceArenaId: string;
  entryFee: number;
  maxPlayers: number;
  stakeToken: Currency;
  /** Seconds the source arena's rounds lasted, preserved on the rematch. */
  roundDurationSeconds?: number;
}

/**
 * Persists the new arena and its `rematchOf` linkage after `create_pool`
 * confirms. The backend verifies `txHash` against the factory before writing,
 * so this must only be called with a confirmed transaction hash.
 */
export async function recordRematchArena(input: RecordRematchInput): Promise<{ id: string }> {
  const response = await fetch("/api/arenas", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: `Rematch of ${input.sourceArenaId.slice(0, 6)}…${input.sourceArenaId.slice(-4)}`,
      entryFee: input.entryFee,
      maxPlayers: input.maxPlayers,
      joinDeadline: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      stakeToken: input.stakeToken,
      txHash: input.txHash,
      rematchOf: input.rematchOf,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new RematchConfigError(
      response.status,
      body?.message ?? `Could not record the rematch arena (${response.status})`,
    );
  }

  const body = (await response.json()) as { arena?: { id: string } };
  if (!body.arena?.id) {
    throw new RematchConfigError(response.status, "Rematch arena response was missing an id");
  }
  return body.arena;
}
