/**
 * Tests for WalletProvider's Stellar-not-configured fallback (#1134).
 *
 * WalletProvider wraps the entire app (via ClientProviders in the root
 * layout), so it renders on every page — including ones with no Stellar
 * dependency at all. It must never throw when Stellar isn't configured;
 * it should fall back to a plain Networks constant instead of reading
 * stellarConfig.network (which throws lazily when misconfigured).
 */
import { render, screen } from "@testing-library/react";
import { useContext } from "react";
import { WalletProvider, WalletContext } from "../WalletProvider";

jest.mock("@creit-tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: jest.fn(),
    authModal: jest.fn(),
    disconnect: jest.fn(),
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
  stellarConfig: { network: string };
} = {
  isStellarConfigured: true,
  stellarConfig: { network: "configured-network" },
};

jest.mock("@/lib/stellarConfig", () => ({
  get isStellarConfigured() {
    return mockStellarConfigState.isStellarConfigured;
  },
  get stellarConfig() {
    return mockStellarConfigState.stellarConfig;
  },
}));

function NetworkProbe() {
  const ctx = useContext(WalletContext);
  return <div data-testid="network">{ctx?.network}</div>;
}

describe("WalletProvider", () => {
  beforeEach(() => {
    mockStellarConfigState.isStellarConfigured = true;
    mockStellarConfigState.stellarConfig = { network: "configured-network" };
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
