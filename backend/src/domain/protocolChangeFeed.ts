/**
 * Protocol change feed (#1690).
 *
 * Normalizes verified on-chain admin events and audited backend changes into one
 * public, versioned chronology of protocol changes. Pure and side-effect free:
 * callers pass candidates in, and get entries, pages and unread counts out.
 *
 * Rules:
 *  - Only provenance-validated contract events and audited backend records may
 *    enter the feed. Anything with `verified: false` is dropped, not shown.
 *  - Ingestion is idempotent. Each entry is keyed by network plus source type
 *    plus source id (transaction event or audit id), so duplicate delivery and
 *    replay collapse into one entry.
 *  - Operator notes are internal and never appear in an entry. Verification
 *    references (tx hash or audit id) are kept so every entry stays checkable.
 *  - A change that a later change reverts is marked `reverted`, and the
 *    original record stays in the feed. Corrections never delete history.
 */

export const CHANGE_FEED_VERSION = 1 as const;

/** Upper bound on entries returned in one page. */
export const CHANGE_FEED_MAX_PAGE_SIZE = 100;

export const CHANGE_KINDS = [
  "pause",
  "unpause",
  "upgrade",
  "registry",
  "fee",
  "oracle_policy",
  "maintenance",
  "other",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type ChangeImpact = "low" | "medium" | "high";

export type ChangeStatus = "scheduled" | "effective" | "cancelled" | "reverted";

/** Impact is a function of the change kind alone, so it is deterministic and reviewable. */
export const IMPACT_BY_KIND: Readonly<Record<ChangeKind, ChangeImpact>> = {
  pause: "high",
  unpause: "high",
  upgrade: "high",
  registry: "medium",
  fee: "medium",
  oracle_policy: "medium",
  maintenance: "low",
  other: "low",
};

/** A change as received from one source, before it is verified or normalized. */
export interface ChangeCandidate {
  sourceType: "contract_event" | "audit_record";
  /** Transaction event id for contract events, audit record id for backend changes. */
  sourceId: string;
  network: string;
  /** Present for contract events. The on-chain verification reference. */
  txHash: string | null;
  /** Present for contract events. Null for audit records. */
  ledgerSequence: number | null;
  /** ISO 8601 time the change took effect, or was recorded for audit records. */
  effectiveAt: string;
  actorClass: "admin" | "operator" | "contract";
  kind: ChangeKind;
  /** What changed, for example `factory`, `oracle`, or `arena:<contractId>`. */
  resource: string;
  previousRevision: string | null;
  newRevision: string | null;
  /** True when provenance was validated (contract event) or the record was audited. */
  verified: boolean;
  /** ISO 8601 time a scheduled change takes effect. Null or past means it is effective. */
  scheduledFor?: string | null;
  /** True when the change was cancelled before it took effect. */
  cancelled?: boolean;
  /** `sourceId` of an earlier change this one reverts. */
  revertsSourceId?: string | null;
  /** Internal. Never published. */
  operatorNote?: string | null;
}

/** Public entry. Carries no operator-internal fields. */
export interface ChangeFeedEntry {
  /** `<network>:<sourceType>:<sourceId>`. Stable and unique. */
  id: string;
  network: string;
  sourceType: ChangeCandidate["sourceType"];
  verificationRef: string;
  txHash: string | null;
  ledgerSequence: number | null;
  effectiveAt: string;
  scheduledFor: string | null;
  actorClass: ChangeCandidate["actorClass"];
  kind: ChangeKind;
  impact: ChangeImpact;
  resource: string;
  previousRevision: string | null;
  newRevision: string | null;
  status: ChangeStatus;
}

export class InvalidChangeFeedCursorError extends Error {
  constructor() {
    super("Change feed cursor is malformed");
    this.name = "InvalidChangeFeedCursorError";
  }
}

function entryId(candidate: ChangeCandidate): string {
  return `${candidate.network}:${candidate.sourceType}:${candidate.sourceId}`;
}

function toStatus(candidate: ChangeCandidate, revertedIds: ReadonlySet<string>, id: string, nowMs: number): ChangeStatus {
  if (candidate.cancelled) return "cancelled";
  if (revertedIds.has(id)) return "reverted";
  if (candidate.scheduledFor && Date.parse(candidate.scheduledFor) > nowMs) return "scheduled";
  return "effective";
}

type SortKey = Pick<ChangeFeedEntry, "id" | "ledgerSequence" | "effectiveAt">;

/** Chronological sort key: newest first, with ledger and id as tie-breakers so same-ledger changes order stably. */
function compareNewestFirst(a: SortKey, b: SortKey): number {
  const byLedger = (b.ledgerSequence ?? -1) - (a.ledgerSequence ?? -1);
  if (byLedger !== 0) return byLedger;
  const byTime = Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Build the canonical feed from raw candidates. Unverified candidates are
 * dropped, duplicates collapse to one entry, reverted changes are marked, and
 * the result is sorted newest first.
 */
export function buildChangeFeed(candidates: readonly ChangeCandidate[], now: Date): ChangeFeedEntry[] {
  const nowMs = now.getTime();
  const verified = candidates.filter((candidate) => candidate.verified);

  // Index by the candidate id so a revert can point at the change it undoes.
  const idByCandidate = new Map<string, ChangeCandidate>();
  for (const candidate of verified) {
    const id = entryId(candidate);
    if (!idByCandidate.has(id)) idByCandidate.set(id, candidate);
  }

  // A revert targets a source id on the same network, whatever its source type.
  const revertedIds = new Set<string>();
  for (const candidate of idByCandidate.values()) {
    if (!candidate.revertsSourceId) continue;
    for (const [id, target] of idByCandidate) {
      if (target.network === candidate.network && target.sourceId === candidate.revertsSourceId) {
        revertedIds.add(id);
      }
    }
  }

  const entries: ChangeFeedEntry[] = [];
  for (const [id, candidate] of idByCandidate) {
    entries.push({
      id,
      network: candidate.network,
      sourceType: candidate.sourceType,
      verificationRef: candidate.txHash ?? `audit:${candidate.sourceId}`,
      txHash: candidate.txHash,
      ledgerSequence: candidate.ledgerSequence,
      effectiveAt: candidate.effectiveAt,
      scheduledFor: candidate.scheduledFor ?? null,
      actorClass: candidate.actorClass,
      kind: candidate.kind,
      impact: IMPACT_BY_KIND[candidate.kind],
      resource: candidate.resource,
      previousRevision: candidate.previousRevision,
      newRevision: candidate.newRevision,
      status: toStatus(candidate, revertedIds, id, nowMs),
    });
  }

  return entries.sort(compareNewestFirst);
}

export interface ChangeFeedFilter {
  kind?: ChangeKind;
  impact?: ChangeImpact;
  resource?: string;
  status?: ChangeStatus;
}

export function filterChangeFeed(entries: readonly ChangeFeedEntry[], filter: ChangeFeedFilter): ChangeFeedEntry[] {
  return entries.filter(
    (entry) =>
      (filter.kind === undefined || entry.kind === filter.kind) &&
      (filter.impact === undefined || entry.impact === filter.impact) &&
      (filter.resource === undefined || entry.resource === filter.resource) &&
      (filter.status === undefined || entry.status === filter.status),
  );
}

interface CursorPayload {
  ledgerSequence: number | null;
  effectiveAt: string;
  id: string;
}

function encodeCursor(entry: ChangeFeedEntry): string {
  const payload: CursorPayload = { ledgerSequence: entry.ledgerSequence, effectiveAt: entry.effectiveAt, id: entry.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidChangeFeedCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CursorPayload).id !== "string" ||
    typeof (parsed as CursorPayload).effectiveAt !== "string"
  ) {
    throw new InvalidChangeFeedCursorError();
  }
  return parsed as CursorPayload;
}

export interface ChangeFeedPage {
  version: typeof CHANGE_FEED_VERSION;
  entries: ChangeFeedEntry[];
  nextCursor: string | null;
}

/**
 * Return the page of entries strictly after `cursor` in feed order. Cursors
 * encode the last returned entry, so a page stays stable when new entries are
 * prepended.
 *
 * @throws InvalidChangeFeedCursorError when the cursor cannot be decoded.
 */
export function pageChangeFeed(
  entries: readonly ChangeFeedEntry[],
  options: { cursor?: string | null; limit?: number } = {},
): ChangeFeedPage {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? CHANGE_FEED_MAX_PAGE_SIZE)), CHANGE_FEED_MAX_PAGE_SIZE);

  let startIndex = 0;
  if (options.cursor) {
    const after = decodeCursor(options.cursor);
    const found = entries.findIndex((entry) => entry.id === after.id);
    // An unknown id means the entry was pruned or never seen. Resume at the first
    // entry that sorts after the cursor, so pagination never restarts from the top.
    if (found !== -1) {
      startIndex = found + 1;
    } else {
      const next = entries.findIndex((entry) => compareNewestFirst(entry, after) > 0);
      startIndex = next === -1 ? entries.length : next;
    }
  }

  const page = entries.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < entries.length;
  return {
    version: CHANGE_FEED_VERSION,
    entries: page,
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
  };
}

/**
 * Entries that became visible after the reader's last visit. An entry counts as
 * unread when it took effect after `lastVisitAt`. Scheduled and cancelled entries
 * are not counted, since they have not changed anything for players yet.
 */
export function countUnreadChanges(entries: readonly ChangeFeedEntry[], lastVisitAt: string | null): number {
  if (lastVisitAt === null) return entries.filter((entry) => entry.status === "effective").length;
  const since = Date.parse(lastVisitAt);
  return entries.filter((entry) => entry.status === "effective" && Date.parse(entry.effectiveAt) > since).length;
}
