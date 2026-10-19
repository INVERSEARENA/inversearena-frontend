import {
  LedgerContinuity,
  type ContinuityEvent,
  type ContinuityState,
  type ContinuityStore,
  type LedgerIdentity,
} from "../src/services/ledgerContinuity";

const ledger = (sequence: number, variant = "a"): LedgerIdentity => ({
  sequence,
  hash: `hash-${sequence}-${variant}`,
});

function memoryStore(): ContinuityStore & { peek(): ContinuityState | null } {
  let stored: string | null = null;
  return {
    load: async () => (stored ? (JSON.parse(stored) as ContinuityState) : null),
    save: async (state) => {
      stored = JSON.stringify(state);
    },
    peek: () => (stored ? (JSON.parse(stored) as ContinuityState) : null),
  };
}

async function observeAll(continuity: LedgerContinuity, identities: LedgerIdentity[]): Promise<void> {
  for (const identity of identities) await continuity.observe(identity);
}

describe("LedgerContinuity (#1490)", () => {
  it("treats normal progression, repeats and lagging reads as continuous", async () => {
    const continuity = new LedgerContinuity();

    expect((await continuity.observe(ledger(100))).outcome).toBe("initial");
    expect((await continuity.observe(ledger(101))).outcome).toBe("advanced");
    expect((await continuity.observe(ledger(102))).outcome).toBe("advanced");
    expect((await continuity.observe(ledger(102))).outcome).toBe("unchanged");
    // A slow endpoint answering with an older ledger whose hash we retained is not a rollback.
    expect((await continuity.observe(ledger(101))).outcome).toBe("lagging");

    expect(continuity.isQuarantined()).toBe(false);
    expect(continuity.getEpoch()).toBe(0);
  });

  it("detects a shallow sequence regression and reports the last verified common point", async () => {
    const continuity = new LedgerContinuity();
    const events: ContinuityEvent[] = [];
    continuity.registerConsumer("test", (event) => {
      events.push(event);
    });
    await observeAll(continuity, [ledger(100), ledger(102), ledger(104)]);

    const result = await continuity.observe(ledger(103, "fork"));

    expect(result).toMatchObject({ outcome: "regression", quarantined: true, epoch: 1 });
    expect(events).toEqual([{ kind: "rollback", epoch: 1, checkpoint: ledger(102), depth: 2 }]);
    expect(continuity.getStatus().checkpoint).toEqual(ledger(102));
  });

  it("detects a same-sequence hash conflict", async () => {
    const continuity = new LedgerContinuity();
    const events: ContinuityEvent[] = [];
    continuity.registerConsumer("test", (event) => {
      events.push(event);
    });
    await observeAll(continuity, [ledger(100), ledger(101), ledger(102)]);

    const result = await continuity.observe(ledger(102, "fork"));

    expect(result).toMatchObject({ outcome: "conflict", quarantined: true });
    expect(events[0]).toEqual({ kind: "rollback", epoch: 1, checkpoint: ledger(101), depth: 1 });
  });

  it("reports a deep rollback beyond the retained window as having no checkpoint", async () => {
    const continuity = new LedgerContinuity({ windowSize: 4 });
    const events: ContinuityEvent[] = [];
    continuity.registerConsumer("test", (event) => {
      events.push(event);
    });
    await observeAll(continuity, Array.from({ length: 11 }, (_, i) => ledger(100 + i)));

    const result = await continuity.observe(ledger(50, "fork"));

    expect(result).toMatchObject({ outcome: "regression", quarantined: true });
    expect(events[0]).toEqual({ kind: "rollback", epoch: 1, checkpoint: null, depth: 61 });
  });

  it("flags a gap beyond the retained window without quarantining", async () => {
    const continuity = new LedgerContinuity({ windowSize: 4 });
    const events: ContinuityEvent[] = [];
    continuity.registerConsumer("test", (event) => {
      events.push(event);
    });
    await continuity.observe(ledger(100));

    const result = await continuity.observe(ledger(110));

    expect(result).toMatchObject({ outcome: "gap", quarantined: false, epoch: 1 });
    expect(events).toEqual([{ kind: "gap", epoch: 1, checkpoint: null, depth: 0 }]);
    expect(continuity.getStatus().latest).toEqual(ledger(110));
  });

  it("recovers after consistent advancing observations and tells consumers to re-baseline", async () => {
    let clock = 1_000;
    const continuity = new LedgerContinuity({ recoveryConfirmations: 2, now: () => clock });
    const events: ContinuityEvent[] = [];
    continuity.registerConsumer("test", (event) => {
      events.push(event);
    });
    await observeAll(continuity, [ledger(100), ledger(101), ledger(102)]);
    await continuity.observe(ledger(102, "fork"));

    expect((await continuity.observe(ledger(103, "fork"))).quarantined).toBe(true);
    clock = 31_000;
    const result = await continuity.observe(ledger(104, "fork"));

    expect(result).toMatchObject({ outcome: "advanced", quarantined: false, recovered: true });
    expect(events.map((event) => event.kind)).toEqual(["rollback", "recovered"]);
    expect(continuity.isQuarantined()).toBe(false);
  });

  it("does not end recovery on repeats or lagging reads", async () => {
    const continuity = new LedgerContinuity({ recoveryConfirmations: 1 });
    await observeAll(continuity, [ledger(100), ledger(101), ledger(102)]);
    await continuity.observe(ledger(102, "fork"));

    expect((await continuity.observe(ledger(102, "fork"))).quarantined).toBe(true);
    expect((await continuity.observe(ledger(101))).quarantined).toBe(true);
    expect((await continuity.observe(ledger(103, "fork"))).quarantined).toBe(false);
  });

  it("keeps the original start and greatest depth when a second rollback lands during recovery", async () => {
    const store = memoryStore();
    let clock = 5_000;
    const continuity = new LedgerContinuity({ store, now: () => clock });
    await observeAll(continuity, [ledger(100), ledger(101), ledger(102), ledger(103)]);
    await continuity.observe(ledger(103, "fork"));
    clock = 9_000;

    await continuity.observe(ledger(101, "fork2"));

    const recovery = store.peek()!.recovery!;
    expect(recovery.startedAt).toBe(5_000);
    expect(recovery.depth).toBe(3);
    expect(recovery.confirmations).toBe(0);
    expect(store.peek()!.epoch).toBe(2);
  });

  it("handles an RPC endpoint switch: a lagging provider is ignored, a conflicting one is a rollback", async () => {
    const continuity = new LedgerContinuity();
    await observeAll(continuity, [ledger(200), ledger(201), ledger(202)]);

    // Provider B is behind but agrees with what we retained.
    expect((await continuity.observe(ledger(200))).quarantined).toBe(false);
    // Provider C reports a different hash for a ledger we already retained.
    expect((await continuity.observe(ledger(201, "other"))).quarantined).toBe(true);
  });

  it("stays quarantined across a restart during recovery and finishes from the persisted state", async () => {
    const store = memoryStore();
    const before = new LedgerContinuity({ store, recoveryConfirmations: 2 });
    await observeAll(before, [ledger(100), ledger(101), ledger(102)]);
    await before.observe(ledger(102, "fork"));

    const after = new LedgerContinuity({ store, recoveryConfirmations: 2 });
    expect(after.isQuarantined()).toBe(false); // nothing loaded yet
    await after.hydrate();
    expect(after.isQuarantined()).toBe(true);
    expect(after.getEpoch()).toBe(1);

    await after.observe(ledger(103, "fork"));
    const result = await after.observe(ledger(104, "fork"));
    expect(result.recovered).toBe(true);
    expect(store.peek()!.recovery).toBeNull();
  });

  it("serializes concurrent observations so workers never interleave window updates", async () => {
    const store = memoryStore();
    const continuity = new LedgerContinuity({ store });

    const results = await Promise.all([
      continuity.observe(ledger(100)),
      continuity.observe(ledger(101)),
      continuity.observe(ledger(102)),
      continuity.observe(ledger(103)),
    ]);

    expect(results.map((result) => result.outcome)).toEqual(["initial", "advanced", "advanced", "advanced"]);
    expect(store.peek()!.window.map((entry) => entry.sequence)).toEqual([100, 101, 102, 103]);
  });

  it("lets a second worker sharing the store see the first worker's rollback", async () => {
    const store = memoryStore();
    const workerA = new LedgerContinuity({ store });
    const workerB = new LedgerContinuity({ store });
    await observeAll(workerA, [ledger(100), ledger(101)]);

    await workerA.observe(ledger(101, "fork"));
    // Worker B's next observation starts from the shared state, so it is judged against the rebuilt window.
    const result = await workerB.observe(ledger(102, "fork"));

    expect(result.quarantined).toBe(true);
    expect(workerB.getEpoch()).toBe(1);
  });

  it("rejects malformed identities", async () => {
    const continuity = new LedgerContinuity();

    await expect(continuity.observe({ sequence: 0, hash: "x" })).rejects.toThrow(TypeError);
    await expect(continuity.observe({ sequence: 5, hash: "" })).rejects.toThrow(TypeError);
  });

  it("keeps notifying other consumers when one consumer fails", async () => {
    const continuity = new LedgerContinuity();
    const seen: string[] = [];
    continuity.registerConsumer("broken", () => {
      throw new Error("boom");
    });
    continuity.registerConsumer("healthy", (event) => {
      seen.push(event.kind);
    });
    await observeAll(continuity, [ledger(100), ledger(101)]);

    await expect(continuity.observe(ledger(101, "fork"))).resolves.toMatchObject({ quarantined: true });

    expect(seen).toEqual(["rollback"]);
  });
});
