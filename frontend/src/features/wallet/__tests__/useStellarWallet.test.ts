import { renderHook, act } from "@testing-library/react";
import { useStellarWallet } from "../useStellarWallet";

const mockInit = jest.fn();
const mockAuthModal = jest.fn();
const mockDisconnect = jest.fn();

jest.mock("@creit-tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: (...args: unknown[]) => mockInit(...args),
    authModal: (...args: unknown[]) => mockAuthModal(...args),
    disconnect: (...args: unknown[]) => mockDisconnect(...args),
  },
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
}));

jest.mock("@creit-tech/stellar-wallets-kit/modules/freighter", () => ({
  FreighterModule: jest.fn(),
}));

jest.mock("@creit-tech/stellar-wallets-kit/modules/xbull", () => ({
  xBullModule: jest.fn(),
}));

jest.mock("@creit-tech/stellar-wallets-kit/modules/albedo", () => ({
  AlbedoModule: jest.fn(),
}));

const TEST_ADDRESS = "GA7QYNF7SOWQ3GLR2BGMQH2NOQEQ4E5K3T2E4ZNU4QJVK2LH3X4Y5Z6W";

describe("useStellarWallet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("initialises with disconnected state", () => {
    const { result } = renderHook(() =>
      useStellarWallet("Test SDF Network ; September 2015" as any)
    );

    expect(result.current.publicKey).toBeNull();
    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe("disconnected");
    expect(result.current.error).toBeNull();
  });

  it("sets publicKey and isConnected on successful connect", async () => {
    mockAuthModal.mockResolvedValueOnce({ address: TEST_ADDRESS });

    const { result } = renderHook(() =>
      useStellarWallet("Test SDF Network ; September 2015" as any)
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.publicKey).toBe(TEST_ADDRESS);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBeNull();
  });

  it("sets status to error on connect failure", async () => {
    mockAuthModal.mockRejectedValueOnce(new Error("User rejected"));

    const { result } = renderHook(() =>
      useStellarWallet("Test SDF Network ; September 2015" as any)
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.publicKey).toBeNull();
    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("User rejected");
  });

  it("resets state on disconnect", async () => {
    mockAuthModal.mockResolvedValueOnce({ address: TEST_ADDRESS });

    const { result } = renderHook(() =>
      useStellarWallet("Test SDF Network ; September 2015" as any)
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.isConnected).toBe(true);

    act(() => {
      result.current.disconnectWallet();
    });

    expect(result.current.publicKey).toBeNull();
    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe("disconnected");
    expect(result.current.error).toBeNull();
  });

  it("calls StellarWalletsKit.init once on mount", () => {
    renderHook(() =>
      useStellarWallet("Test SDF Network ; September 2015" as any)
    );

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith({
      network: "Test SDF Network ; September 2015",
      modules: expect.any(Array),
    });
  });

  it("does not reinit if network prop is stable", () => {
    const { rerender } = renderHook(
      ({ network }) => useStellarWallet(network),
      {
        initialProps: {
          network: "Test SDF Network ; September 2015" as any,
        },
      }
    );

    rerender({ network: "Test SDF Network ; September 2015" as any });

    expect(mockInit).toHaveBeenCalledTimes(1);
  });
});
