/**
 * Pure decoder for treasury-relevant on-chain events (#1511).
 *
 * Split out from `services/treasury/treasuryEventReader.ts` so this module
 * has no dependency on `StellarRpcGateway` (which crosses the
 * frontend/backend package boundary and fails `tsc`'s `rootDir` check — see
 * that file's own doc comment) — keeping this file, and anything that only
 * needs decoding logic (like its own unit tests), independently testable.
 *
 * Deliberately NOT built on `onChainReader.ts`'s `toArenaProjectionEvent`
 * (the #1382 canonical arena projection): that decoder matches raw event
 * topics against `ARENA_EVENT_TOPICS` (`INIT`, `CFGD`, ..., `RWAYLD` — all
 * uppercase), but the actual deployed arena contract
 * (`contract/arena/src/events.rs`) emits lowercase topics via
 * `symbol_short!(...)` (`"init"`, `"claimed"`, `"fee_upd"`, ...), several of
 * which don't exist in `ARENA_EVENT_TOPICS` at all. `isArenaEventTopic` does
 * an exact string match with no case-folding or translation, so every real
 * event decodes as `ArenaUnknownEvent` — that whole subsystem does not
 * currently see any real on-chain event. This is a separate, larger
 * pre-existing bug, flagged but intentionally not fixed here (see
 * `backend/docs/TREASURY_RECONCILIATION_DESIGN.md` §2).
 *
 * This module decodes only the treasury-relevant events:
 *  - `"claimed"` — `(gross: i128, fee: i128, net: i128, yield_amount: i128,
 *    treasury: Address)`, keyed by the winner address topic segment. Emitted
 *    once per arena, when the winner calls `claim()`. `fee` is the platform
 *    cut routed to `treasury` and `net` what the winner actually received
 *    (#1554).
 *  - `"fee_coll"` — `(fee: i128, fee_bps: u32)`, keyed by the treasury
 *    address topic segment (#1554). Emitted at settlement whenever a nonzero
 *    platform fee is routed, so treasury revenue is directly attributable.
 *  - `"fee_upd"` — `new_fee_bps: u32`, keyed by the admin address topic
 *    segment. Lets the service determine which `platform_fee_bps` was in
 *    effect at the ledger a given `claimed` event landed at.
 */

import { scValToNative, type rpc } from "@stellar/stellar-sdk";

export const TREASURY_EVENT_TOPICS = ["claimed", "fee_coll", "fee_upd"] as const;
export type TreasuryEventTopic = (typeof TREASURY_EVENT_TOPICS)[number];

interface BaseTreasuryEvent {
  /** Soroban RPC `EventResponse.id` — stable, unique per ledger + event index. */
  id: string;
  contractId: string;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
}

export interface ClaimedTreasuryEvent extends BaseTreasuryEvent {
  topic: "claimed";
  winner: string;
  /** Total withdrawn from the yield vault (principal + yield), in stroops. */
  grossAtomic: bigint;
  /** Platform fee routed to `treasury`, in stroops. */
  feeAtomic: bigint;
  /** Amount actually paid to the winner (`gross - fee`), in stroops. */
  netAtomic: bigint;
  /** The yield-only portion of the gross — this is what a platform fee applies to. */
  yieldAmountAtomic: bigint;
  /** Treasury address the fee was routed to, as published on the event. */
  treasury: string;
}

export interface FeeCollectedTreasuryEvent extends BaseTreasuryEvent {
  topic: "fee_coll";
  /** Treasury address that received the fee. */
  treasury: string;
  /** Fee amount routed to the treasury, in stroops. */
  feeAtomic: bigint;
  /** The `platform_fee_bps` used to compute the fee. */
  feeBps: number;
}

export interface FeeUpdatedTreasuryEvent extends BaseTreasuryEvent {
  topic: "fee_upd";
  admin: string;
  feeBps: number;
}

export interface UnknownTreasuryEvent extends BaseTreasuryEvent {
  topic: "unknown";
  rawTopic: string | null;
  reason: string;
}

export type TreasuryEvent =
  | ClaimedTreasuryEvent
  | FeeCollectedTreasuryEvent
  | FeeUpdatedTreasuryEvent
  | UnknownTreasuryEvent;

export function isTreasuryEventTopic(value: string): value is TreasuryEventTopic {
  return (TREASURY_EVENT_TOPICS as readonly string[]).includes(value);
}

/** Decodes a raw Soroban RPC event into a `TreasuryEvent`. Never throws. */
export function toTreasuryEvent(raw: rpc.Api.EventResponse): TreasuryEvent {
  const base: BaseTreasuryEvent = {
    id: raw.id,
    contractId: raw.contractId?.toString() ?? "",
    ledgerSequence: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
  };

  let topicString: string;
  try {
    const topicValue = raw.topic[0] !== undefined ? scValToNative(raw.topic[0]) : undefined;
    topicString = typeof topicValue === "string" ? topicValue : String(topicValue ?? "");
  } catch (error) {
    return {
      ...base,
      topic: "unknown",
      rawTopic: null,
      reason: `Failed to decode topic symbol: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isTreasuryEventTopic(topicString)) {
    return { ...base, topic: "unknown", rawTopic: topicString || null, reason: "Not a treasury-relevant topic" };
  }

  // `topic[1]` (when present) carries the address segment the contract
  // co-published alongside the fixed symbol, e.g. `(symbol_short!("claimed"), winner)`.
  let addressSegment = "";
  try {
    if (raw.topic[1] !== undefined) addressSegment = String(scValToNative(raw.topic[1]));
  } catch {
    // Non-fatal — fall through with an empty address; the event is still
    // decodable and reconciliation can flag the gap rather than dropping it.
  }

  try {
    const value = scValToNative(raw.value);

    if (topicString === "claimed") {
      // Published as `(gross, fee, net, yield_amount, treasury)` (#1554).
      if (!Array.isArray(value) || value.length !== 5) {
        return {
          ...base,
          topic: "unknown",
          rawTopic: topicString,
          reason: `Expected a 5-tuple (gross, fee, net, yield_amount, treasury), got ${Array.isArray(value) ? `${value.length}-tuple` : typeof value}`,
        };
      }
      const [gross, fee, net, yieldAmount, treasury] = value;
      return {
        ...base,
        topic: "claimed",
        winner: addressSegment,
        grossAtomic: toAtomic(gross),
        feeAtomic: toAtomic(fee),
        netAtomic: toAtomic(net),
        yieldAmountAtomic: toAtomic(yieldAmount),
        treasury: typeof treasury === "string" ? treasury : String(treasury),
      };
    }

    if (topicString === "fee_coll") {
      // Published as `(fee, fee_bps)` (#1554).
      if (!Array.isArray(value) || value.length !== 2) {
        return {
          ...base,
          topic: "unknown",
          rawTopic: topicString,
          reason: `Expected a 2-tuple (fee, fee_bps), got ${Array.isArray(value) ? `${value.length}-tuple` : typeof value}`,
        };
      }
      const [fee, feeBps] = value;
      return {
        ...base,
        topic: "fee_coll",
        treasury: addressSegment,
        feeAtomic: toAtomic(fee),
        feeBps: Number(feeBps),
      };
    }

    // "fee_upd" — a single u32, decoded as a plain number.
    return {
      ...base,
      topic: "fee_upd",
      admin: addressSegment,
      feeBps: Number(value),
    };
  } catch (error) {
    return {
      ...base,
      topic: "unknown",
      rawTopic: topicString,
      reason: `Failed to decode event payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Coerce an `scValToNative` integer (bigint, number, or string) to bigint stroops. */
function toAtomic(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value as string);
}
