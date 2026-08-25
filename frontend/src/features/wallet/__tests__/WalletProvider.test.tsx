/**
 * Tests for WalletProvider: the StellarWalletsKit-backed context that
 * replaced the separate Freighter-direct wallet hook (#1230), and the
 * Stellar-not-configured fallback (#1134).
 *
 * WalletProvider wraps the entire app (via ClientProviders in the root
 * layout), so it renders on every page — including ones with no Stellar
 * dependency at all. It must never throw when Stellar isn't configured;
 * it should fall back to a plain Networks constant instead of reading
 * stellarConfig.network (which throws lazily when misconfigured).
 */
import React, { useContext } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WalletProvider, WalletContext } from "../WalletProvider";
import { useWallet } from "../useWallet";

jest.mock("@creit-tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: jest.fn(),
    authModal: jest.fn(),
    disconnect: jest.fn(),
    getAddress: jest.fn(),
    signTransaction: jest.fn(),
  },
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
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

const mockStellarConfigState: {
  isStellarConfigured: boolean;
  stellarConfig: { network: string; horizonUrl: string };
} = {
  isStellarConfigured: true,
  stellarConfig: { network: "configured-network", horizonUrl: "https://horizon.example" },
};

jest.mock("@/lib/stellarConfig", () => ({
  get isStellarConfigured() {
    return mockStellarConfigState.isStellarConfigured;
  },
  get stellarConfig() {
    return mockStellarConfigState.stellarConfig;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StellarWalletsKit } = require("@creit-tech/stellar-wallets-kit");

const VALID_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function NetworkProbe() {
  const ctx = useContext(WalletContext);
  return <div data-testid="network">{ctx?.network}</div>;
}

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
    mockStellarConfigState.isStellarConfigured = true;
    mockStellarConfigState.stellarConfig = {
      network: "configured-network",
      horizonUrl: "https://horizon.example",
    };
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

describe("WalletProvider Stellar-not-configured fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockStellarConfigState.isStellarConfigured = true;
    mockStellarConfigState.stellarConfig = {
      network: "configured-network",
      horizonUrl: "https://horizon.example",
    };
  });

  it("uses stellarConfig.network when Stellar is configured", () => {
    render(
      <WalletProvider>
        <NetworkProbe />
      </WalletProvider>,
    );

    expect(screen.getByTestId("network").textContent).toBe("configured-network");
  });

  it("does not throw and falls back to Networks.TESTNET when Stellar is not configured", () => {
    mockStellarConfigState.isStellarConfigured = false;

    expect(() =>
      render(
        <WalletProvider>
          <NetworkProbe />
        </WalletProvider>,
      ),
    ).not.toThrow();

    expect(screen.getByTestId("network").textContent).toBe("Test SDF Network ; September 2015");
  });

  it("still renders children when Stellar is not configured", () => {
    mockStellarConfigState.isStellarConfigured = false;

    render(
      <WalletProvider>
        <div data-testid="child">unrelated page content</div>
      </WalletProvider>,
    );

    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
