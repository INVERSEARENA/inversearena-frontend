/**
 * Arena event decoding. Mirrors contract/arena/src/events.rs: topic[0] is the
 * "arena" namespace (#1607), topic[1] the event name, further topics are
 * indexed fields, and data is a tuple whose first element is the schema
 * version.
 */
import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";
import { toJsonSafe } from "./encode.js";

interface Layout {
  /** Readable name. */
  event: string;
  /** Names of topics after the event name. */
  topics: string[];
  /** Names of data fields after the schema version. */
  data: string[];
}

export const ARENA_EVENT_LAYOUTS: Record<string, Layout> = {
  init: { event: "initialized", topics: [], data: ["admin"] },
  join: { event: "player_joined", topics: ["player"], data: ["player_count"] },
  ban: { event: "player_banned", topics: ["admin"], data: ["player"] },
  unban: { event: "player_unbanned", topics: ["admin"], data: ["player"] },
  left: { event: "player_left", topics: ["player"], data: ["player_count"] },
  refunded: { event: "player_refunded", topics: ["player"], data: ["amount"] },
  limits: { event: "player_limits_configured", topics: [], data: ["min_players", "max_players"] },
  fee_upd: { event: "platform_fee_updated", topics: ["admin"], data: ["new_fee_bps"] },
  up_prop: { event: "upgrade_proposed", topics: [], data: ["new_wasm_hash", "proposed_at"] },
  upgrade: { event: "upgraded", topics: [], data: ["new_wasm_hash"] },
  started: { event: "game_started", topics: [], data: ["round", "duration_seconds"] },
  resolved: { event: "round_resolved", topics: [], data: ["round", "eliminated", "survivors"] },
  rslvd2: { event: "round_resolved_v2", topics: ["round"], data: ["heads", "tails", "eliminated", "survivors"] },
  tied: { event: "round_tied", topics: [], data: ["round", "survivors"] },
  elim: { event: "player_eliminated", topics: ["player"], data: ["round"] },
  finished: { event: "game_finished", topics: [], data: ["winner", "round"] },
  claimed: { event: "prize_claimed", topics: ["winner"], data: ["amount", "yield_amount"] },
  admin: { event: "admin_changed", topics: [], data: ["old_admin", "new_admin"] },
  paused: { event: "paused", topics: ["caller"], data: ["reason"] },
  unpaused: { event: "unpaused", topics: ["caller"], data: [] },
  expired: { event: "arena_expired", topics: [], data: [] },
  vaultdec: { event: "vault_balance_decreased", topics: [], data: ["previous_balance", "current_balance"] },
  vault_orc_f: { event: "vault_oracle_failed", topics: ["oracle"], data: [] },
  frsh_pol: { event: "oracle_freshness_policy_updated", topics: ["admin"], data: ["max_age_secs", "warn_age_secs"] },
  orc_fresh: { event: "oracle_freshness_observed", topics: [], data: ["round", "classification", "age_secs"] },
  orc_stale: { event: "oracle_stale_rejected", topics: [], data: ["round", "age_secs"] },
  cancel: { event: "arena_cancelled", topics: ["admin"], data: [] },
  refund: { event: "refund_claimed", topics: ["player"], data: [] },
  lboard: { event: "leaderboard_updated", topics: [], data: [] },
  commit: { event: "commitment_submitted", topics: ["player"], data: ["round"] },
  reveal: { event: "choice_revealed", topics: ["player"], data: ["choice", "round"] },
};

export interface DecodedEvent {
  id: string;
  ledger: number;
  closedAt: string;
  event: string;
  fields: Record<string, unknown>;
  /** Present when the event is not in the layout table (newer contract). */
  raw?: { topics: unknown[]; data: unknown };
}

const native = (value: xdr.ScVal) => toJsonSafe(scValToNative(value));

export function decodeArenaEvent(event: Pick<rpc.Api.EventResponse, "id" | "ledger" | "ledgerClosedAt" | "topic" | "value">): DecodedEvent {
  const topics = event.topic.map(native);
  const data = native(event.value);
  const name = String(topics[1] ?? topics[0] ?? "unknown");
  const layout = topics[0] === "arena" ? ARENA_EVENT_LAYOUTS[name] : undefined;
  const base = { id: event.id, ledger: event.ledger, closedAt: event.ledgerClosedAt };
  if (!layout || !Array.isArray(data)) return { ...base, event: name, fields: {}, raw: { topics, data } };

  const fields: Record<string, unknown> = { schema_version: data[0] };
  layout.topics.forEach((field, i) => (fields[field] = topics[2 + i]));
  layout.data.forEach((field, i) => (fields[field] = data[1 + i]));
  return { ...base, event: layout.event, fields };
}

/** Events that belong to `round`: those whose decoded `round` field matches. */
export function filterRound(events: DecodedEvent[], round: number): DecodedEvent[] {
  return events.filter((e) => e.fields.round !== undefined && Number(e.fields.round) === round);
}

export interface FetchEventsOptions {
  contractId: string;
  /** How far back from the latest ledger to search when no start is given. */
  lookbackLedgers: number;
  startLedger?: number | undefined;
  maxPages?: number;
}

/** Page through getEvents for one contract. */
export async function fetchContractEvents(server: rpc.Server, options: FetchEventsOptions): Promise<rpc.Api.EventResponse[]> {
  // RPC nodes only keep a window of ledgers; start inside it.
  const { oldestLedger, latestLedger } = await server.getHealth();
  if (options.startLedger !== undefined && (options.startLedger < oldestLedger || options.startLedger > latestLedger)) {
    throw new Error(`--start-ledger ${options.startLedger} is outside the RPC's retained range ${oldestLedger}-${latestLedger}`);
  }
  const startLedger = options.startLedger ?? Math.max(oldestLedger, latestLedger - options.lookbackLedgers);
  const filters = [{ type: "contract" as const, contractIds: [options.contractId] }];
  const limit = 200;
  const events: rpc.Api.EventResponse[] = [];
  let page = await server.getEvents({ filters, startLedger, limit });
  for (let i = 0; ; i++) {
    events.push(...page.events);
    if (page.events.length < limit || i + 1 >= (options.maxPages ?? 50)) break;
    page = await server.getEvents({ filters, cursor: page.cursor, limit });
  }
  return events;
}
