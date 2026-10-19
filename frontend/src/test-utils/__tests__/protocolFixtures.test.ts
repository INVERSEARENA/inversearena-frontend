import {
  buildArenaState,
  buildArenaStateFromContract,
  buildArenaStoreSnapshot,
  buildClaimInboxComponent,
  buildClaimInboxItem,
  buildClaimInboxPage,
  buildRoundProofBundle,
  invalidArenaState,
  invalidArenaStateFromContract,
  invalidClaimInboxComponent,
  invalidClaimInboxPage,
} from "@/test-utils/protocolFixtures";
import { claimInboxPageSchema } from "@/features/claim-inbox/types";

describe("protocolFixtures — valid defaults", () => {
  it("builds a valid arena state and applies overrides", () => {
    const arena = buildArenaState({ status: "settled", survivors: 1 });
    expect(arena.status).toBe("settled");
    expect(arena.survivors).toBe(1);
    expect(arena.survivors).toBeLessThanOrEqual(arena.capacity);
  });

  it("builds a valid contract read result", () => {
    const fromContract = buildArenaStateFromContract();
    expect(fromContract.arenaId).toMatch(/^C[A-Z0-9]{55}$/);
    expect(fromContract.contractArenaState.capacity).toBeGreaterThan(0);
  });

  it("builds a valid store snapshot with the requested health", () => {
    expect(buildArenaStoreSnapshot({}, "degraded").health).toBe("degraded");
  });

  it("produces a claim inbox page that satisfies the runtime schema", () => {
    const parsed = claimInboxPageSchema.safeParse(buildClaimInboxPage());
    expect(parsed.success).toBe(true);
  });

  it("keeps the claim inbox summary consistent with its items", () => {
    const page = buildClaimInboxPage({
      items: [
        buildClaimInboxItem({ state: "actionable" }),
        buildClaimInboxItem({ id: "claim-2", state: "completed" }),
      ],
    });
    expect(page.summary.actionable).toBe(1);
    expect(page.summary.completed).toBe(1);
    expect(page.summary.total).toBe(2);
  });

  it("builds a version-1 proof bundle", () => {
    expect(buildRoundProofBundle().version).toBe(1);
  });
});

describe("protocolFixtures — boundary and determinism", () => {
  it("handles an empty claim inbox page", () => {
    const page = buildClaimInboxPage({ items: [] });
    expect(page.summary.total).toBe(0);
    expect(claimInboxPageSchema.safeParse(page).success).toBe(true);
  });

  it("is idempotent across repeated builds", () => {
    expect(buildArenaState()).toEqual(buildArenaState());
    expect(buildClaimInboxItem()).toEqual(buildClaimInboxItem());
  });

  it("returns a fresh object each call", () => {
    const first = buildClaimInboxComponent();
    first.amountStroops = "0";
    expect(buildClaimInboxComponent().amountStroops).not.toBe("0");
  });
});

describe("protocolFixtures — invalid-state helpers", () => {
  it("exposes a survivor-count invariant violation", () => {
    const bad = invalidArenaState();
    expect(bad.survivors).toBeGreaterThan(bad.capacity);
  });

  it("exposes a negative entry fee", () => {
    expect(invalidArenaStateFromContract().entryFee).toBeLessThan(0);
  });

  it("rejects the invalid claim inbox page at the schema boundary", () => {
    expect(claimInboxPageSchema.safeParse(invalidClaimInboxPage()).success).toBe(false);
  });

  it("rejects an invalid component folded into a page", () => {
    const page = buildClaimInboxPage({
      items: [buildClaimInboxItem({ components: [invalidClaimInboxComponent() as never] })],
    });
    expect(claimInboxPageSchema.safeParse(page).success).toBe(false);
  });
});
