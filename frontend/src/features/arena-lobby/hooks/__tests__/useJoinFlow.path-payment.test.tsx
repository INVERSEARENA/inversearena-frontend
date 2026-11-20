/**
 * Funded-join flow tests (#1716). These keep the wallet, Horizon quoting and
 * transaction-intent API at their boundaries so the assertions focus on what
 * the hook decides: which source is quoted, when a quote is refreshed, and how
 * a policy-rejected bundle falls back to two resumable intents.
 */

import { act, renderHook } from "@testing-library/react";
import { useTransactionIntent } from "@/shared/lib/hooks/useTransactionIntent";
import {
  evaluateSigningRequest,
  SigningPolicyError,
} from "@/shared/lib/security/policy";
import { fetchBestStrictReceiveQuote, type PathQuote } from "@/shared/lib/stellar/path-payment-quote";
import {
  buildJoinArenaTransaction,
  buildJoinWithPathPaymentTransaction,
  buildPathPaymentTransaction,
} from "@/shared/lib/stellar/stellar-transactions";
import { useAssetReadinessGate } from "@/features/asset-readiness";
import type { ArenaStats } from "../useLobbyData";
import { useJoinFlow } from "../useJoinFlow";

jest.mock("@/shared/lib/hooks/useTransactionIntent", () => ({
  useTransactionIntent: jest.fn(),
}));

jest.mock("@/shared/config/stellarConfig", () => ({
  isStellarConfigured: true,
  stellarConfig: {
    horizonUrl: "https://horizon.test",
    assetIssuers: { USDC: "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL" },
  },
}));

jest.mock("@/features/asset-readiness", () => ({
  useAssetReadinessGate: jest.fn(),
}));

jest.mock("@/shared/lib/stellar/stellar-fee-estimator", () => ({
  getJoinArenaFee: jest.fn(() => "10000"),
}));

jest.mock("@/shared/lib/security/policy", () => {
  const actual = jest.requireActual("@/shared/lib/security/policy");
  return { ...actual, evaluateSigningRequest: jest.fn() };
});

jest.mock("@/shared/lib/stellar/path-payment-quote", () => {
  const actual = jest.requireActual("@/shared/lib/stellar/path-payment-quote");
  return { ...actual, fetchBestStrictReceiveQuote: jest.fn() };
});

jest.mock("@/shared/lib/stellar/stellar-transactions", () => ({
  buildJoinArenaTransaction: jest.fn(),
  buildJoinWithPathPaymentTransaction: jest.fn(),
  buildLeaveArenaTransaction: jest.fn(),
  buildPathPaymentTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ISSUER = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";
const ARENA_ID = "arena-1716";

const stats: ArenaStats = {
  arenaId: ARENA_ID,
  arenaName: "Funded Arena",
  currentPot: 0,
  playerCount: 1,
  maxPlayers: 8,
  survivorCount: 1,
  currentRound: 1,
  entryFee: 10,
  stakeToken: "USDC",
  joinDeadline: null,
  yieldAccrued: 0,
  status: "OPEN",
  lastUpdated: new Date().toISOString(),
};

function makeQuote(now: number): PathQuote {
  return {
    sourceAsset: { kind: "native", code: "XLM" },
    destinationAsset: { kind: "credit", code: "USDC", issuer: ISSUER },
    sourceAmount: "12.3000000",
    destinationAmount: "10.0000000",
    sendMax: "12.4230000",
    path: [],
    slippageBps: 100,
    createdAt: now,
    expiresAt: now + 30_000,
  };
}

const unsignedTx = { toXDR: () => "unsigned-xdr" };

describe("useJoinFlow funded joins", () => {
  let runTrackedTransaction: jest.Mock;
  let onJoinSuccess: jest.Mock;
  let onSigned: jest.Mock;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);

    runTrackedTransaction = jest.fn(async (options: { buildTransaction: () => Promise<unknown>; onSigned: () => void }) => {
      await options.buildTransaction();
      options.onSigned();
    });
    (useTransactionIntent as jest.Mock).mockReturnValue({ runTrackedTransaction });
    (useAssetReadinessGate as jest.Mock).mockReturnValue({
      canProceed: true,
      phase: "ready",
      message: "",
      check: jest.fn(),
    });

    (evaluateSigningRequest as jest.Mock).mockImplementation((_xdr: string, opType: string) => ({
      type: opType,
      source: PUBLIC_KEY,
      fee: "10000",
      seq: 1,
      network: "Test SDF Network ; September 2015",
      operations: [],
      timebounds: { minTime: "0", maxTime: "9999999" },
    }));

    (buildJoinWithPathPaymentTransaction as jest.Mock).mockResolvedValue(unsignedTx);
    (buildPathPaymentTransaction as jest.Mock).mockResolvedValue(unsignedTx);
    (buildJoinArenaTransaction as jest.Mock).mockResolvedValue(unsignedTx);

    onJoinSuccess = jest.fn().mockResolvedValue(undefined);
    onSigned = jest.fn();
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  function renderFlow() {
    return renderHook(() =>
      useJoinFlow({
        arenaId: ARENA_ID,
        stats,
        wallet: {
          publicKey: PUBLIC_KEY,
          isConnected: true,
          signTransaction: jest.fn(),
        },
        onJoinSuccess,
        onLeaveSuccess: jest.fn(),
      }),
    );
  }

  it("quotes the selected source asset and refreshes a stale quote before bundling", async () => {
    (fetchBestStrictReceiveQuote as jest.Mock).mockResolvedValueOnce(makeQuote(1_000_000));
    const { result } = renderFlow();

    act(() => {
      result.current.selectSourceAsset("XLM");
    });
    await act(async () => {
      await result.current.refreshPathQuote();
    });

    expect(fetchBestStrictReceiveQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        horizonBaseUrl: "https://horizon.test",
        sourceAssets: [{ kind: "native", code: "XLM" }],
        destinationAsset: { kind: "credit", code: "USDC", issuer: ISSUER },
        destinationAmount: "10.0000000",
      }),
    );
    expect(result.current.pathQuote?.expiresAt).toBe(1_030_000);

    nowSpy.mockReturnValue(1_040_000);
    (fetchBestStrictReceiveQuote as jest.Mock).mockResolvedValueOnce(makeQuote(1_040_000));

    await act(async () => {
      await result.current.handleConfirmJoin({ onSigned });
    });

    expect(fetchBestStrictReceiveQuote).toHaveBeenCalledTimes(2);
    expect(result.current.pathQuote?.expiresAt).toBe(1_070_000);
    expect(buildJoinWithPathPaymentTransaction).toHaveBeenCalledTimes(1);
    expect(buildPathPaymentTransaction).not.toHaveBeenCalled();
    expect(onJoinSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.fundingMode).toBe("bundled");
    expect(onSigned).toHaveBeenCalledTimes(1);
  });

  it("falls back to two resumable intents when bundled signing is policy-rejected", async () => {
    (fetchBestStrictReceiveQuote as jest.Mock).mockResolvedValue(makeQuote(1_000_000));
    (evaluateSigningRequest as jest.Mock).mockImplementation((_xdr: string, opType: string) => {
      if (opType === "JOIN_PATH") {
        throw new SigningPolicyError(
          "unexpected_operation",
          "JOIN_PATH",
          "Bundled funded joins are unavailable",
        );
      }
      return { type: opType, operations: [] };
    });
    const { result } = renderFlow();

    act(() => {
      result.current.selectSourceAsset("XLM");
    });
    await act(async () => {
      await result.current.refreshPathQuote();
    });

    await act(async () => {
      await result.current.handleConfirmJoin({ onSigned });
    });

    expect(runTrackedTransaction.mock.calls.map(([options]) => options.actionKey)).toEqual([
      "join_path:arena-1716",
      "join_funding:arena-1716",
      "join_arena:arena-1716",
    ]);
    expect(buildJoinWithPathPaymentTransaction).toHaveBeenCalledTimes(1);
    expect(buildPathPaymentTransaction).toHaveBeenCalledTimes(1);
    expect(buildJoinArenaTransaction).toHaveBeenCalledTimes(1);
    expect(onJoinSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.fundingMode).toBe("two_step");
    expect(result.current.joinError).toBeNull();
  });

  it("skips the bundled attempt when two-step mode is explicitly requested", async () => {
    (fetchBestStrictReceiveQuote as jest.Mock).mockResolvedValue(makeQuote(1_000_000));
    const { result } = renderFlow();

    act(() => {
      result.current.selectSourceAsset("XLM");
      result.current.setPreferTwoStep(true);
    });
    await act(async () => {
      await result.current.refreshPathQuote();
    });

    await act(async () => {
      await result.current.handleConfirmJoin({ onSigned });
    });

    expect(buildJoinWithPathPaymentTransaction).not.toHaveBeenCalled();
    expect(buildPathPaymentTransaction).toHaveBeenCalledTimes(1);
    expect(buildJoinArenaTransaction).toHaveBeenCalledTimes(1);
    expect(result.current.fundingMode).toBe("two_step");
  });
});
