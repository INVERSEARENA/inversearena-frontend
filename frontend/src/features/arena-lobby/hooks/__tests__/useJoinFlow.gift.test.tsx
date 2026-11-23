import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GiftSeatPanel } from "../../components/GiftSeatPanel";
import { useJoinFlow } from "../useJoinFlow";
import {
  buildJoinArenaForTransaction,
  submitSignedTransaction,
} from "@/shared/lib/stellar/stellar-transactions";

jest.mock("@/shared/lib/hooks/useTransactionIntent", () => ({
  useTransactionIntent: () => ({
    runTrackedTransaction: async (options: {
      buildTransaction: () => Promise<{ toXDR: () => string }>;
      signTransaction: (xdr: string) => Promise<string>;
      submitSignedTransaction: (xdr: string) => Promise<void>;
      onSigned: () => void;
    }) => {
      const unsigned = await options.buildTransaction();
      const signed = await options.signTransaction(unsigned.toXDR());
      options.onSigned();
      await options.submitSignedTransaction(signed);
    },
  }),
}));

jest.mock("@/shared/lib/stellar/stellar-transactions", () => ({
  buildJoinArenaForTransaction: jest.fn(),
  buildJoinArenaTransaction: jest.fn(),
  buildLeaveArenaTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  parseStellarError: (error: unknown) =>
    error instanceof Error ? error.message : "Unknown error",
}));

jest.mock("@/shared/lib/security/policy", () => ({
  evaluateSigningRequest: jest.fn(() => ({
    type: "JOIN",
    operations: [{ type: "invokeHostFunction" }],
  })),
  SigningPolicyError: class SigningPolicyError extends Error {},
}));

jest.mock("@/features/asset-readiness", () => ({
  useAssetReadinessGate: () => ({
    canProceed: true,
    phase: "ready",
    message: "",
    remediation: null,
    canRetry: false,
    check: jest.fn(),
    remediate: jest.fn(),
  }),
}));

const PAYER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const RECIPIENT = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

const STATS = {
  arenaId: "arena-1",
  arenaName: "Alpha Arena",
  currentPot: 1000,
  playerCount: 10,
  maxPlayers: 100,
  survivorCount: 10,
  currentRound: 0,
  entryFee: 100,
  stakeToken: "XLM",
  joinDeadline: new Date(Date.now() + 60_000).toISOString(),
  yieldAccrued: 5,
  status: "open" as const,
  lastUpdated: new Date().toISOString(),
};

const signTransaction = jest.fn();

function Harness() {
  const flow = useJoinFlow({
    arenaId: "arena-1",
    stats: STATS,
    wallet: {
      publicKey: PAYER,
      isConnected: true,
      signTransaction,
    },
    onJoinSuccess: jest.fn().mockResolvedValue(undefined),
    onLeaveSuccess: jest.fn().mockResolvedValue(undefined),
  });

  return (
    <GiftSeatPanel
      flow={flow}
      payerWallet={PAYER}
      entryFee={STATS.entryFee}
      stakeToken={STATS.stakeToken}
    />
  );
}

async function openGiftModal(recipient: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Gift a seat" }));
  fireEvent.change(await screen.findByLabelText(/recipient address/i), {
    target: { value: recipient },
  });
  return screen.findByRole("button", { name: /sign & gift/i, hidden: true });
}

describe("Gift a seat flow (#1715)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    signTransaction.mockResolvedValue("signed-xdr");
    (buildJoinArenaForTransaction as jest.Mock).mockResolvedValue({
      toXDR: () => "unsigned-xdr",
    });
    (submitSignedTransaction as jest.Mock).mockResolvedValue(undefined);

    global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/reservation")) {
        return Promise.resolve({
          ok: init?.method !== "DELETE",
          status: init?.method === "DELETE" ? 204 : 201,
          json: async () => ({}),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });
  });

  it("rejects an invalid recipient before building a sponsored transaction", async () => {
    render(<Harness />);

    const confirm = await openGiftModal("not-a-stellar-address");
    fireEvent.click(confirm);

    expect(
      (await screen.findAllByText(/enter a valid stellar account address/i)).length,
    ).toBeGreaterThan(0);
    expect(buildJoinArenaForTransaction).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("builds and signs join_arena_for with the connected payer and the recipient", async () => {
    render(<Harness />);

    const confirm = await openGiftModal(RECIPIENT);
    fireEvent.click(confirm);

    await waitFor(
      () => {
        expect(buildJoinArenaForTransaction).toHaveBeenCalledWith(
          PAYER,
          RECIPIENT,
          "arena-1",
        );
      },
      { timeout: 3000 },
    );
    expect(signTransaction).toHaveBeenCalledWith("unsigned-xdr");
    expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");
  });

  it("explains the payer and refund destination in the confirmation", async () => {
    render(<Harness />);

    await openGiftModal(RECIPIENT);

    expect(
      await screen.findByText(/you fund the entry fee/i, { selector: "p" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Refund destination").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Prize recipient").length).toBeGreaterThan(0);
  });
});
