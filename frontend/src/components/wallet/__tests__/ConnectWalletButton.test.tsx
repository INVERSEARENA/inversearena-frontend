import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectWalletButton } from "../ConnectWalletButton";
import { useWallet } from "@/features/wallet/useWallet";
import { usePasskeyWallet } from "@/features/wallet/usePasskeyWallet";

jest.mock("@/features/wallet/useWallet", () => ({
  useWallet: jest.fn(),
}));
jest.mock("@/features/wallet/usePasskeyWallet", () => ({
  usePasskeyWallet: jest.fn(),
}));

const mockUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;
const mockUsePasskeyWallet = usePasskeyWallet as jest.MockedFunction<
  typeof usePasskeyWallet
>;

const baseWallet = {
  status: "disconnected" as const,
  publicKey: null,
  address: null,
  error: null,
  network: "Test SDF Network ; September 2015",
  isConnected: false,
  balance: { xlm: 0, usdc: 0 },
  isLoadingBalance: false,
  balanceError: null,
  connect: jest.fn(),
  disconnect: jest.fn(),
  signTransaction: jest.fn(),
  refreshBalance: jest.fn(),
  walletNetworkName: null,
  recheckNetwork: jest.fn(),
};

const basePasskey = {
  address: null,
  keyId: null,
  isRegistered: false,
  error: null,
  isAvailable: false,
  register: jest.fn(),
  sign: jest.fn(),
  disconnect: jest.fn(),
};

describe("ConnectWalletButton network-mismatch state (#1404)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsePasskeyWallet.mockReturnValue(basePasskey);
  });

  it("shows a wrong-network message naming the wallet's actual network", () => {
    mockUseWallet.mockReturnValue({
      ...baseWallet,
      status: "network-mismatch",
      publicKey: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      isConnected: true,
      walletNetworkName: "Public Global Stellar Network ; September 2015",
    });

    render(<ConnectWalletButton />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /wrong network/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Public Global Stellar Network/,
    );
    expect(
      screen.getByRole("button", { name: /check again/i }),
    ).toBeInTheDocument();
  });

  it("calls recheckNetwork when 'Check again' is clicked", async () => {
    const recheckNetwork = jest.fn().mockResolvedValue(undefined);
    mockUseWallet.mockReturnValue({
      ...baseWallet,
      status: "network-mismatch",
      isConnected: true,
      walletNetworkName: "Public Global Stellar Network ; September 2015",
      recheckNetwork,
    });

    render(<ConnectWalletButton />);

    fireEvent.click(screen.getByRole("button", { name: /check again/i }));

    await waitFor(() => expect(recheckNetwork).toHaveBeenCalledTimes(1));
  });

  it("still offers Disconnect while in network-mismatch state", () => {
    const disconnect = jest.fn();
    mockUseWallet.mockReturnValue({
      ...baseWallet,
      status: "network-mismatch",
      isConnected: true,
      walletNetworkName: "Public Global Stellar Network ; September 2015",
      disconnect,
    });

    render(<ConnectWalletButton />);

    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not show the wrong-network message once status returns to connected", () => {
    mockUseWallet.mockReturnValue({
      ...baseWallet,
      status: "connected",
      publicKey: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      isConnected: true,
      walletNetworkName: null,
    });

    render(<ConnectWalletButton />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /check again/i }),
    ).not.toBeInTheDocument();
  });
});
