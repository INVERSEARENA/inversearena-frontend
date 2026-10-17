import {
  savePoolDraft,
  loadPoolDraft,
  clearPoolDraft,
} from "../pool-draft";
import { StorageKey } from "../localStorage";
import { POOL_DRAFT_VERSION } from "../pool-schema";

describe("pool draft persistence (#1405)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const fields = {
    stakeAmountInput: "250",
    currency: "USDC" as const,
    roundSpeed: "5M" as const,
    arenaCapacity: 200,
  };

  it("returns null when nothing has been saved", () => {
    expect(loadPoolDraft()).toBeNull();
  });

  it("round-trips a saved draft", () => {
    savePoolDraft(fields);

    const draft = loadPoolDraft();
    expect(draft).not.toBeNull();
    expect(draft?.stakeAmountInput).toBe("250");
    expect(draft?.currency).toBe("USDC");
    expect(draft?.roundSpeed).toBe("5M");
    expect(draft?.arenaCapacity).toBe(200);
    expect(draft?.version).toBe(POOL_DRAFT_VERSION);
    expect(typeof draft?.savedAt).toBe("number");
  });

  it("clearPoolDraft removes the persisted draft", () => {
    savePoolDraft(fields);
    expect(loadPoolDraft()).not.toBeNull();

    clearPoolDraft();

    expect(loadPoolDraft()).toBeNull();
  });

  it("discards and clears a draft saved under an older/incompatible version", () => {
    window.localStorage.setItem(
      StorageKey.ARENA_POOL_DRAFT,
      JSON.stringify({
        version: POOL_DRAFT_VERSION - 1,
        stakeAmountInput: "250",
        currency: "USDC",
        roundSpeed: "5M",
        arenaCapacity: 200,
        savedAt: Date.now(),
      }),
    );

    expect(loadPoolDraft()).toBeNull();
    // The incompatible entry should be gone, not just ignored, so it can't
    // resurface on a later load.
    expect(window.localStorage.getItem(StorageKey.ARENA_POOL_DRAFT)).toBeNull();
  });

  it("discards a draft with a field of the wrong type", () => {
    window.localStorage.setItem(
      StorageKey.ARENA_POOL_DRAFT,
      JSON.stringify({
        version: POOL_DRAFT_VERSION,
        stakeAmountInput: "250",
        currency: "USDC",
        roundSpeed: "5M",
        arenaCapacity: "not-a-number",
        savedAt: Date.now(),
      }),
    );

    expect(loadPoolDraft()).toBeNull();
  });

  it("discards a draft with an invalid currency", () => {
    window.localStorage.setItem(
      StorageKey.ARENA_POOL_DRAFT,
      JSON.stringify({
        version: POOL_DRAFT_VERSION,
        stakeAmountInput: "250",
        currency: "BTC",
        roundSpeed: "5M",
        arenaCapacity: 200,
        savedAt: Date.now(),
      }),
    );

    expect(loadPoolDraft()).toBeNull();
  });

  it("discards hand-corrupted (non-JSON) localStorage content without throwing", () => {
    window.localStorage.setItem(StorageKey.ARENA_POOL_DRAFT, "{not json");

    expect(() => loadPoolDraft()).not.toThrow();
    expect(loadPoolDraft()).toBeNull();
  });

  it("overwrites a previous draft on a second save rather than merging", () => {
    savePoolDraft(fields);
    savePoolDraft({ ...fields, arenaCapacity: 999, currency: "XLM" });

    const draft = loadPoolDraft();
    expect(draft?.arenaCapacity).toBe(999);
    expect(draft?.currency).toBe("XLM");
  });
});
