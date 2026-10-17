import { localStorageManager, StorageKey } from "./localStorage";
import {
  poolDraftSchema,
  POOL_DRAFT_VERSION,
  type PoolDraft,
} from "./pool-schema";
import type { Currency } from "./form-validation";
import type { RoundSpeed } from "./pool-schema";

/**
 * Pool-creation draft persistence (#1405). Saves the in-progress
 * PoolCreationModal form to localStorage so it survives an accidental
 * close/reload, and safely discards it if the persisted shape no longer
 * matches poolDraftSchema (a stale/incompatible draft from an older build).
 */

export interface PoolDraftFields {
  stakeAmountInput: string;
  currency: Currency;
  roundSpeed: RoundSpeed;
  arenaCapacity: number;
}

export function savePoolDraft(fields: PoolDraftFields): void {
  const draft: PoolDraft = {
    version: POOL_DRAFT_VERSION,
    stakeAmountInput: fields.stakeAmountInput,
    currency: fields.currency,
    roundSpeed: fields.roundSpeed,
    arenaCapacity: fields.arenaCapacity,
    savedAt: Date.now(),
  };
  localStorageManager.setItem(StorageKey.ARENA_POOL_DRAFT, draft);
}

/**
 * Returns the persisted draft only if it parses cleanly against the
 * current poolDraftSchema (including an exact version match via
 * z.literal(POOL_DRAFT_VERSION)). Any other stored value: wrong version,
 * hand-edited localStorage, or a shape from a future/older build, returns
 * null and clears the incompatible entry so it can't resurface partially
 * and confuse a later save.
 */
export function loadPoolDraft(): PoolDraft | null {
  const raw = localStorageManager.getItem<unknown>(
    StorageKey.ARENA_POOL_DRAFT,
    null,
  );
  if (raw === null) return null;

  const result = poolDraftSchema.safeParse(raw);
  if (!result.success) {
    clearPoolDraft();
    return null;
  }

  return result.data;
}

export function clearPoolDraft(): void {
  localStorageManager.removeItem(StorageKey.ARENA_POOL_DRAFT);
}
