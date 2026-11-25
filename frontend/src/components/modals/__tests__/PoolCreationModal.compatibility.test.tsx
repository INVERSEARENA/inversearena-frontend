import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { PoolCreationModal } from "../PoolCreationModal";
import { useWallet } from "@/features/wallet/hooks/useWallet";
import { fetchVaultConfig } from "@/shared/lib/stellar/stellar-transactions";

jest.mock("@/features/wallet/hooks/useWallet", () => ({
  useWallet: jest.fn(),
}));
jest.mock("@/shared/config/stellarConfig", () => {
  const actual = jest.requireActual("@/shared/config/stellarConfig");
  return {
    ...actual,
    stellarConfig: { ...actual.stellarConfig, oracleContractId: "ORACLE" },
  };
});
jest.mock("@/shared/lib/stellar/stellar-transactions", () => ({
  buildCreatePoolTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
  fetchVaultConfig: jest.fn(),
  POOL_TOKEN_IDS: { USDC: "USDC_TOKEN", XLM: "XLM_TOKEN" },
}));

const mockUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;
const mockFetchVaultConfig = fetchVaultConfig as jest.MockedFunction<typeof fetchVaultConfig>;

function walletState() {
  return {
    isConnected: true,
    address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    publicKey: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    status: "connected" as const,
    error: null,
    network: "TESTNET",
    balance: { xlm: 1000, usdc: 1000 },
    isLoadingBalance: false,
    balanceError: null,
    connect: jest.fn(),
    disconnect: jest.fn(),
    signTransaction: jest.fn(),
    refreshBalance: jest.fn(),
    walletNetworkName: null,
    recheckNetwork: jest.fn(),
  } as unknown as ReturnType<typeof useWallet>;
}

function offeredCurrencies(): string[] {
  const select = screen.getByLabelText("Currency selection") as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.value);
}

describe("PoolCreationModal vault compatibility (#1634)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockUseWallet.mockReturnValue(walletState());
    // The modal's whitelist check calls fetch, which jsdom does not provide.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ isWhitelisted: true }),
    }) as unknown as typeof fetch;
  });

  it("offers only the currency the yield vault holds", async () => {
    mockFetchVaultConfig.mockResolvedValue({ stakeToken: "XLM_TOKEN", oracle: "ORACLE" });

    render(<PoolCreationModal isOpen={true} onClose={jest.fn()} />);

    await waitFor(() => expect(offeredCurrencies()).toEqual(["XLM"]));
    // The default USDC selection moves to the only compatible currency.
    expect((screen.getByLabelText("Currency selection") as HTMLSelectElement).value).toBe("XLM");
  });

  it("blocks creation when the vault uses a different oracle", async () => {
    mockFetchVaultConfig.mockResolvedValue({ stakeToken: "USDC_TOKEN", oracle: "OTHER" });

    render(<PoolCreationModal isOpen={true} onClose={jest.fn()} />);

    expect(await screen.findByText(/Pool creation is unavailable/)).toBeInTheDocument();
    expect(screen.getByLabelText("Initialize arena")).toBeDisabled();
  });

  it("keeps every currency selectable when the vault cannot be read", async () => {
    mockFetchVaultConfig.mockRejectedValue(new Error("rpc down"));

    render(<PoolCreationModal isOpen={true} onClose={jest.fn()} />);

    await waitFor(() => expect(mockFetchVaultConfig).toHaveBeenCalled());
    expect(offeredCurrencies()).toEqual(["USDC", "XLM"]);
  });
});
