import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WalletProvider } from "../WalletProvider";
import { useWallet } from "../useWallet";

jest.mock("@creit-tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: jest.fn(),
    authModal: jest.fn(),
    disconnect: jest.fn(),
    getAddress: jest.fn(),
    signTransaction: jest.fn(),
  },
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
}));

jest.mock("@creit-tech/stellar-wallets-kit/modules/freighter", () => ({
  FreighterModule: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@creit-tech/stellar-wallets-kit/modules/xbull", () => ({
  xBullModule: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@creit-tech/stellar-wallets-kit/modules/albedo", () => ({
  AlbedoModule: jest.fn().mockImplementation(() => ({})),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StellarWalletsKit } = require("@creit-tech/stellar-wallets-kit");

const VALID_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

// Stand-ins for two previously-separate consumer families: one that used to
// read from the StellarWalletsKit context (e.g. ConnectWalletButton), and
// one that used to read from the Freighter-direct hook (e.g. StakeModal /
// PoolCreationModal). Both now read from the same `useWallet()` context.
function NavbarLikeConsumer() {
  const { status, publicKey } = useWallet();
  return (
    <div>
      <span data-testid="navbar-status">{status}</span>
      <span data-testid="navbar-address">{publicKey ?? "none"}</span>
    </div>
  );
}

function StakeModalLikeConsumer() {
  const { isConnected, address, connect } = useWallet();
  return (
    <div>
      <span data-testid="stake-connected">{String(isConnected)}</span>
      <span data-testid="stake-address">{address ?? "none"}</span>
      <button onClick={() => void connect()}>Connect from StakeModal</button>
    </div>
  );
}

describe("WalletProvider consolidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = jest.fn().mockResolvedValue({ ok: false });
  });

  it("propagates a connection made by one consumer to every other consumer under the same provider", async () => {
    StellarWalletsKit.authModal.mockResolvedValue({ address: VALID_KEY });

    render(
      <WalletProvider>
        <NavbarLikeConsumer />
        <StakeModalLikeConsumer />
      </WalletProvider>,
    );

    expect(screen.getByTestId("navbar-status").textContent).toBe("disconnected");
    expect(screen.getByTestId("stake-connected").textContent).toBe("false");

    fireEvent.click(screen.getByText("Connect from StakeModal"));

    await waitFor(() => {
      expect(screen.getByTestId("navbar-status").textContent).toBe("connected");
    });

    // Before consolidation, StakeModal read from an entirely separate
    // Freighter-direct wallet instance, so the navbar (context-backed) would
    // stay "disconnected" here even though the user had just connected.
    expect(screen.getByTestId("navbar-address").textContent).toBe(VALID_KEY);
    expect(screen.getByTestId("stake-connected").textContent).toBe("true");
    expect(screen.getByTestId("stake-address").textContent).toBe(VALID_KEY);
  });
});
