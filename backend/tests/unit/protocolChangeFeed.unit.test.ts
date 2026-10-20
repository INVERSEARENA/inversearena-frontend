import {
  buildChangeFeed,
  countUnreadChanges,
  filterChangeFeed,
  InvalidChangeFeedCursorError,
  pageChangeFeed,
  type ChangeCandidate,
} from "../../src/domain/protocolChangeFeed";

const NETWORK = "stellar-testnet";
const NOW = new Date("2026-06-10T12:00:00.000Z");

function contract(overrides: Partial<ChangeCandidate> & Pick<ChangeCandidate, "sourceId">): ChangeCandidate {
  return {
    sourceType: "contract_event",
    network: NETWORK,
    txHash: `tx-${overrides.sourceId}`,
    ledgerSequence: 100,
    effectiveAt: "2026-06-01T00:00:00.000Z",
    actorClass: "admin",
    kind: "fee",
    resource: "factory",
    previousRevision: "1",
    newRevision: "2",
    verified: true,
    ...overrides,
  };
}

function audit(overrides: Partial<ChangeCandidate> & Pick<ChangeCandidate, "sourceId">): ChangeCandidate {
  return {
    sourceType: "audit_record",
    network: NETWORK,
    txHash: null,
    ledgerSequence: null,
    effectiveAt: "2026-06-02T00:00:00.000Z",
    actorClass: "operator",
    kind: "maintenance",
    resource: "backend",
    previousRevision: null,
    newRevision: null,
    verified: true,
    ...overrides,
  };
}

describe("buildChangeFeed", () => {
  it("keeps only provenance-validated contract events and audited records", () => {
    const feed = buildChangeFeed(
      [contract({ sourceId: "a", verified: false }), contract({ sourceId: "b" }), audit({ sourceId: "c", verified: false })],
      NOW,
    );
    expect(feed.map((entry) => entry.id)).toEqual([`${NETWORK}:contract_event:b`]);
  });

  it("collapses duplicate delivery of the same source into one entry", () => {
    const feed = buildChangeFeed([contract({ sourceId: "a" }), contract({ sourceId: "a" }), contract({ sourceId: "a" })], NOW);
    expect(feed).toHaveLength(1);
  });

  it("never publishes operator notes and keeps the verification reference", () => {
    const feed = buildChangeFeed([contract({ sourceId: "a", operatorNote: "internal: rotate signer 7" })], NOW);
    expect(JSON.stringify(feed)).not.toContain("internal");
    expect(feed[0]).toMatchObject({ verificationRef: "tx-a", txHash: "tx-a" });
  });

  it("uses an audit id as the verification reference for backend changes", () => {
    const [entry] = buildChangeFeed([audit({ sourceId: "rec-9" })], NOW);
    expect(entry.verificationRef).toBe("audit:rec-9");
  });

  it("classifies impact deterministically from the kind", () => {
    const feed = buildChangeFeed(
      [
        contract({ sourceId: "p", kind: "pause", ledgerSequence: 1 }),
        contract({ sourceId: "r", kind: "registry", ledgerSequence: 2 }),
        audit({ sourceId: "m", kind: "maintenance" }),
      ],
      NOW,
    );
    const impactById = Object.fromEntries(feed.map((entry) => [entry.kind, entry.impact]));
    expect(impactById).toEqual({ pause: "high", registry: "medium", maintenance: "low" });
  });

  it("marks a reverted upgrade and keeps the original record", () => {
    const feed = buildChangeFeed(
      [
        contract({ sourceId: "up1", kind: "upgrade", ledgerSequence: 10 }),
        contract({ sourceId: "rev1", kind: "upgrade", ledgerSequence: 11, revertsSourceId: "up1" }),
      ],
      NOW,
    );
    expect(feed.find((entry) => entry.id.endsWith(":up1"))?.status).toBe("reverted");
    expect(feed.find((entry) => entry.id.endsWith(":rev1"))?.status).toBe("effective");
    expect(feed).toHaveLength(2);
  });

  it("reports scheduled, cancelled and effective statuses against the clock", () => {
    const feed = buildChangeFeed(
      [
        contract({ sourceId: "later", ledgerSequence: 5, scheduledFor: "2026-07-01T00:00:00.000Z" }),
        contract({ sourceId: "dropped", ledgerSequence: 4, cancelled: true }),
        contract({ sourceId: "past", ledgerSequence: 3, scheduledFor: "2026-06-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    const statusById = Object.fromEntries(feed.map((entry) => [entry.sourceType + entry.verificationRef, entry.status]));
    expect(statusById).toEqual({
      "contract_eventtx-later": "scheduled",
      "contract_eventtx-dropped": "cancelled",
      "contract_eventtx-past": "effective",
    });
  });

  it("orders newest first and breaks same-ledger ties by id", () => {
    const feed = buildChangeFeed(
      [
        contract({ sourceId: "older", ledgerSequence: 1 }),
        contract({ sourceId: "tieB", ledgerSequence: 9 }),
        contract({ sourceId: "tieA", ledgerSequence: 9 }),
      ],
      NOW,
    );
    // Same-ledger ties fall back to id, descending, so the order is stable across runs.
    expect(feed.map((entry) => entry.verificationRef)).toEqual(["tx-tieB", "tx-tieA", "tx-older"]);
  });
});

describe("pageChangeFeed", () => {
  const feed = buildChangeFeed(
    Array.from({ length: 7 }, (_, index) => contract({ sourceId: `e${index}`, ledgerSequence: index })),
    NOW,
  );

  it("pages through every entry exactly once", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = pageChangeFeed(feed, { cursor, limit: 3 });
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(feed.map((entry) => entry.id));
  });

  it("resumes correctly when the cursor's entry has been pruned", () => {
    const first = pageChangeFeed(feed, { limit: 2 });
    const pruned = feed.filter((entry) => entry.id !== first.entries[1].id);
    const next = pageChangeFeed(pruned, { cursor: first.nextCursor, limit: 10 });
    expect(next.entries.map((entry) => entry.id)).toEqual(feed.slice(2).map((entry) => entry.id));
  });

  it("rejects a malformed cursor", () => {
    expect(() => pageChangeFeed(feed, { cursor: "%%%" })).toThrow(InvalidChangeFeedCursorError);
    expect(() => pageChangeFeed(feed, { cursor: Buffer.from('{"x":1}').toString("base64url") })).toThrow(
      InvalidChangeFeedCursorError,
    );
  });

  it("clamps the page size", () => {
    expect(pageChangeFeed(feed, { limit: 10_000 }).entries).toHaveLength(7);
    expect(pageChangeFeed(feed, { limit: 0 }).entries).toHaveLength(1);
  });
});

describe("filterChangeFeed and countUnreadChanges", () => {
  const feed = buildChangeFeed(
    [
      contract({ sourceId: "fee", kind: "fee", ledgerSequence: 2, effectiveAt: "2026-06-05T00:00:00.000Z" }),
      contract({ sourceId: "pause", kind: "pause", ledgerSequence: 3, effectiveAt: "2026-06-06T00:00:00.000Z" }),
      contract({ sourceId: "queued", kind: "fee", ledgerSequence: 4, scheduledFor: "2026-08-01T00:00:00.000Z", effectiveAt: "2026-06-07T00:00:00.000Z" }),
    ],
    NOW,
  );

  it("filters by kind and status", () => {
    expect(filterChangeFeed(feed, { kind: "fee" })).toHaveLength(2);
    expect(filterChangeFeed(feed, { status: "scheduled" }).map((entry) => entry.kind)).toEqual(["fee"]);
  });

  it("counts effective changes since the last visit, ignoring scheduled ones", () => {
    expect(countUnreadChanges(feed, "2026-06-05T12:00:00.000Z")).toBe(1);
    expect(countUnreadChanges(feed, null)).toBe(2);
    expect(countUnreadChanges(feed, "2026-07-01T00:00:00.000Z")).toBe(0);
  });
});
