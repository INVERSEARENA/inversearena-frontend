import React from "react";
import { screen, waitFor } from "@testing-library/react";
import ArenaResultPage from "../page";
import { renderWithIntl } from "@/test-utils/renderWithIntl";
import { fetchRematchConfig } from "@/features/pools/model/rematch-config";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "ARENA-1" }),
  useRouter: () => ({ push }),
}));
jest.mock("@/features/wallet/hooks/useWallet", () => ({
  useWallet: () => ({ publicKey: null }),
}));
jest.mock("@/features/pools/model/rematch-config", () => ({
  fetchRematchConfig: jest.fn(),
}));

const mockFetchRematchConfig = fetchRematchConfig as jest.MockedFunction<typeof fetchRematchConfig>;

const priorParticipantConfig = {
  arenaId: "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3",
  available: true,
  blockedReason: null,
  blockedMessage: null,
  host: "GHOST",
  poolId: 1,
  factoryContractId: "CFACTORY",
  isPriorParticipant: true,
  config: {
    stakeToken: "CUSDC",
    yieldVault: "CVAULT",
    entryFee: "1000000000",
    oracleContract: "CORACLE",
    minPlayers: 2,
    maxPlayers: 8,
    roundDuration: 60,
  },
};

describe("ArenaResultPage rematch CTA (#1572)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("offers a rematch when the arena can be rematched", async () => {
    mockFetchRematchConfig.mockResolvedValue(priorParticipantConfig);

    renderWithIntl(<ArenaResultPage />);

    const cta = await screen.findByText("START REMATCH");
    expect(cta).toBeInTheDocument();
    expect(screen.getByText("REMATCH AVAILABLE")).toBeInTheDocument();
  });

  it("does not offer a rematch when the backend reports it is blocked", async () => {
    mockFetchRematchConfig.mockResolvedValue({
      ...priorParticipantConfig,
      available: false,
      blockedReason: "HOST_ACTIVE_POOL_LIMIT",
      blockedMessage: "at the limit",
    });

    renderWithIntl(<ArenaResultPage />);

    // Wait for the result data to settle, then assert the CTA never showed.
    await waitFor(() =>
      expect(screen.getByText(/GAME OVER/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("START REMATCH")).not.toBeInTheDocument();
  });

  it("degrades to the normal result page when the rematch config read fails", async () => {
    mockFetchRematchConfig.mockRejectedValue(new Error("503"));

    renderWithIntl(<ArenaResultPage />);

    await waitFor(() =>
      expect(screen.getByText(/GAME OVER/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("REMATCH AVAILABLE")).not.toBeInTheDocument();
  });
});
