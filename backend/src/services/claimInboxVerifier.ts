/**
 * On-chain arena verification for the claim inbox (#1489).
 *
 * Split out of `claimInboxService` so the service has no dependency on
 * `onChainReader`, which reaches across into the frontend package for its RPC
 * gateway. The backend `tsconfig` cannot compile that file — it sits outside
 * `rootDir` and uses path aliases the backend does not define — so a service
 * that imported it would be neither buildable nor testable. The service takes
 * its verifier by injection; this module is the production implementation.
 *
 * @module
 */

import { getOnChainGameState } from "./onChainReader";
import type { ClaimInboxArenaState } from "../types/claimInbox";
import type { ClaimInboxVerifier } from "./claimInboxService";

/**
 * Verify a batch of arenas, one RPC read each, in parallel.
 *
 * Parallel because the reads are independent and the whole set is bounded by
 * the caller's wall-clock budget: run serially, latency would be the arena
 * count multiplied by a single read, and any wallet with a few positions
 * would exhaust the budget and see everything report `unavailable`.
 *
 * A per-arena failure is dropped rather than thrown, because one bad contract
 * id must not make the whole inbox unreadable — the other positions are still
 * actionable and still worth showing. The dropped arena is not silently
 * treated as verified: the caller distinguishes "absent from the map" from
 * "read successfully" and reports the former as `unavailable`.
 */
export const verifyArenasOnChain: ClaimInboxVerifier = async (arenaIds) => {
  const entries = await Promise.all(
    arenaIds.map(async (arenaId) => {
      try {
        return [arenaId, (await getOnChainGameState(arenaId)) as ClaimInboxArenaState] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(
    entries.filter((entry): entry is readonly [string, ClaimInboxArenaState] => entry !== null),
  );
};
