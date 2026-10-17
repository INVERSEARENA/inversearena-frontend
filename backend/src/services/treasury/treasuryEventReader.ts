/**
 * Treasury-relevant on-chain event fetching (#1511).
 *
 * Thin I/O wrapper around `domain/treasuryEventDecoder.ts`'s pure decoder —
 * see that module's doc comment for why the decoding logic lives there
 * (rootDir-safe, independently unit-testable) rather than here. This file
 * owns only the RPC call + pagination, mirroring
 * `onChainReader.ts`'s `getArenaEvents` pagination contract exactly (one RPC
 * call per page; batching/looping belongs to the caller).
 */

import { StellarRpcGateway } from "../../../../frontend/src/shared-d/services/stellarRpcGateway";
import { getStellarConfig } from "../../config/stellarConfig";
import { toTreasuryEvent } from "../../domain/treasuryEventDecoder";
import type { TreasuryEvent } from "../../domain/treasuryEventDecoder";

export interface TreasuryEventPage {
  events: TreasuryEvent[];
  latestLedger: number;
  cursor: string | null;
}

export const DEFAULT_TREASURY_EVENT_PAGE_SIZE = 1000;

/**
 * Fetch a single page of treasury-relevant events for a contract.
 */
export async function getTreasuryEvents(
  contractId: string,
  options: { startLedger: number; cursor?: undefined } | { cursor: string; startLedger?: undefined },
  limit: number = DEFAULT_TREASURY_EVENT_PAGE_SIZE,
): Promise<TreasuryEventPage> {
  const stellarRpcGateway = new StellarRpcGateway();
  const paginationArg: { cursor: string } | { startLedger: number } =
    "cursor" in options && options.cursor
      ? { cursor: options.cursor }
      : { startLedger: options.startLedger as number };

  const response = await stellarRpcGateway.getEvents({
    filters: [{ type: "contract", contractIds: [contractId] }],
    ...paginationArg,
    limit,
  });

  const events = response.events.map(toTreasuryEvent);
  const lastRawEvent = response.events[response.events.length - 1];
  const cursor = events.length >= limit && lastRawEvent ? lastRawEvent.pagingToken : null;

  return { events, latestLedger: response.latestLedger, cursor };
}

/** Network key derived the same way `ArenaProjectionCheckpoint.network` is — never hardcoded. */
export function currentTreasuryNetwork(): string {
  return getStellarConfig().networkPassphrase;
}

export {
  TREASURY_EVENT_TOPICS,
  isTreasuryEventTopic,
  toTreasuryEvent,
  type TreasuryEventTopic,
  type ClaimedTreasuryEvent,
  type FeeUpdatedTreasuryEvent,
  type UnknownTreasuryEvent,
  type TreasuryEvent,
} from "../../domain/treasuryEventDecoder";
