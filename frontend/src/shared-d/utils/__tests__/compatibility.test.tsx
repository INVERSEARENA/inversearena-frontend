/**
 * Compatibility manifest and gate (#1491). Unit cases first; then the integration
 * case: a capability the
 * deployment does not support must be refused before any transaction is built,
 * so it can never reach the wallet signing prompt. Uses the real transaction
 * builders, the real TransactionModal and the real compatibility store; only
 * the wallet and the network are stubbed.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TransactionModal, type TransactionProgress } from "@/components/modals/TransactionModal";
import { buildSubmitCommitmentTransaction } from "../stellar-transactions";
import { ContractError } from "../contract-error";
import {
  MANIFEST_MAX_AGE_MS,
  assertCapability,
  compatibilityStore,
  createCompatibilityStore,
  parseCompatibilityManifest,
} from "../compatibility-store";
import { loadCommitment } from "../commit-reveal";

const PASSPHRASE = "Test SDF Network ; September 2015";

function manifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    network: { passphrase: PASSPHRASE },
    configRevision: 1_000,
    generatedAt: "2026-01-01T00:00:00.000Z",
    contracts: [],
    capabilities: {
      join: { status: "supported" },
      commit: { status: "supported" },
      reveal: { status: "supported" },
      claim: { status: "supported" },
    },
    ...overrides,
  };
}

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ARENA = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const signTransaction = jest.fn(async (xdr: string) => `signed:${xdr.length}`);
const horizonFetch = jest.fn();

function CommitFlow() {
  return (
    <TransactionModal
      isOpen
      onClose={jest.fn()}
      title="Commit Choice"
      details={[{ label: "Round", value: "#1" }]}
      confirmLabel="Sign & Commit"
      // Same shape as the arena page: build the transaction, then hand it to the wallet.
      onConfirm={async ({ onSigned }: TransactionProgress) => {
        const tx = await buildSubmitCommitmentTransaction(PUBLIC_KEY, ARENA, "Heads", 1);
        await signTransaction(tx.toXDR());
        onSigned();
      }}
    />
  );
}

async function approve() {
  fireEvent.click(screen.getByText("Sign & Commit"));
  // The modal holds SIGNING for 500ms before awaiting onConfirm.
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  localStorage.clear();
  compatibilityStore.reset();
  horizonFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ sequence: "1" }) });
  (global.fetch as unknown) = horizonFetch;
});

afterEach(() => {
  jest.useRealTimers();
  compatibilityStore.reset();
});

describe("compatibility gate before wallet signing (#1491)", () => {
  it("never reaches the wallet, the network or local commitment storage when commit is unsupported", async () => {
    compatibilityStore.applyResponse(
      ARENA,
      manifestFixture({
        capabilities: { commit: { status: "unsupported", reason: "contract_version", requiredVersion: 3 } },
      }),
      PASSPHRASE,
    );

    render(<CommitFlow />);
    await approve();

    expect(signTransaction).not.toHaveBeenCalled();
    expect(horizonFetch).not.toHaveBeenCalled();
    expect(loadCommitment(ARENA, 1, PUBLIC_KEY)).toBeNull();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/needs contract version 3 or newer/)).toBeInTheDocument();
  });

  it("does not block a supported capability", async () => {
    compatibilityStore.applyResponse(ARENA, manifestFixture(), PASSPHRASE);

    render(<CommitFlow />);
    await approve();

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Success!")).toBeInTheDocument();
  });

  it("does not block when no manifest is known (backend without the endpoint)", async () => {
    render(<CommitFlow />);
    await approve();

    expect(signTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("compatibility manifest handling (#1491)", () => {
  const ARENA_2 = "COTHER";

  it("blocks only the affected capability for a mixed-version arena", () => {
    const store = createCompatibilityStore();
    store.applyResponse(null, manifestFixture(), PASSPHRASE);
    store.applyResponse(
      ARENA,
      manifestFixture({
        capabilities: { reveal: { status: "unsupported", reason: "contract_version", requiredVersion: 3 } },
      }),
      PASSPHRASE,
    );

    expect(store.getDecision("reveal", ARENA)).toMatchObject({ allowed: false, reason: "unsupported" });
    expect(store.getDecision("join", ARENA)).toEqual({ allowed: true, state: "supported" });
    expect(store.getDecision("reveal", ARENA_2)).toEqual({ allowed: true, state: "supported" });
    expect(() => assertCapability("reveal", ARENA, "fn", store)).toThrow(ContractError);
  });

  it("never replaces a manifest with an older revision, and distrusts one past the max age", () => {
    let clock = 1_000_000;
    const store = createCompatibilityStore({ now: () => clock });
    store.applyResponse(ARENA, manifestFixture({ configRevision: 2_000 }), PASSPHRASE);

    expect(
      store.applyResponse(
        ARENA,
        manifestFixture({
          configRevision: 1_500,
          capabilities: { join: { status: "unsupported", reason: "contract_version" } },
        }),
        PASSPHRASE,
      ),
    ).toBe("ignored_older_revision");
    expect(store.getDecision("join", ARENA)).toEqual({ allowed: true, state: "supported" });

    clock += MANIFEST_MAX_AGE_MS + 1;
    expect(store.getDecision("join", ARENA)).toMatchObject({ allowed: false, reason: "stale" });
  });

  it("ignores unknown fields and capabilities, and rejects unsupported schemas and other networks", () => {
    const ok = parseCompatibilityManifest(
      manifestFixture({ future: 1, capabilities: { teleport: { status: "supported" } } }),
      PASSPHRASE,
    );
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.manifest).not.toHaveProperty("future");
    expect(parseCompatibilityManifest(manifestFixture({ schemaVersion: 2 }), PASSPHRASE)).toEqual({
      ok: false,
      error: "unsupported_schema",
    });
    expect(
      parseCompatibilityManifest(manifestFixture({ network: { passphrase: "Other" } }), PASSPHRASE),
    ).toEqual({ ok: false, error: "network_mismatch" });
    expect(parseCompatibilityManifest({ nonsense: true }, PASSPHRASE)).toEqual({ ok: false, error: "invalid" });
  });

  it("blocks on negotiation failure and allows when the backend has no endpoint", () => {
    const store = createCompatibilityStore();
    store.applyResponse(
      ARENA,
      manifestFixture({ capabilities: { claim: { status: "unsupported", reason: "negotiation_failed" } } }),
      PASSPHRASE,
    );
    expect(store.getDecision("claim", ARENA)).toMatchObject({ allowed: false, reason: "negotiation_failed" });

    const legacy = createCompatibilityStore();
    legacy.markLegacyBackend(null);
    expect(legacy.getDecision("claim", ARENA)).toEqual({ allowed: true, state: "unverified" });
  });
});
