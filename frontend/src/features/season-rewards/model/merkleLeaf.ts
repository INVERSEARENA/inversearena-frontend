/** Deterministic season-reward leaf encoding for the future distributor flow (#1861). */
export interface SeasonRewardLeaf {
  readonly season: string;
  readonly wallet: string;
  readonly amount: string;
}

/**
 * Canonical, domain-separated payload shared by a backend tree builder and a
 * frontend proof verifier. Hashing is deliberately left to the caller so this
 * module remains usable in browser and worker runtimes.
 */
export function encodeSeasonRewardLeaf(leaf: SeasonRewardLeaf, distributor: string): Uint8Array {
  const payload = `IA_SEASON_REWARD_V1\0${distributor}\0${leaf.season}\0${leaf.wallet}\0${leaf.amount}`;
  return new TextEncoder().encode(payload);
}
