import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import { Networks } from "@creit-tech/stellar-wallets-kit";
import { isValidStellarPublicKey } from "../useStellarWallet";

describe("isValidStellarPublicKey", () => {
  it("accepts a well-formed Stellar public key", () => {
    expect(
      isValidStellarPublicKey(
        "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      ),
    ).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidStellarPublicKey("")).toBe(false);
  });

  it("rejects a key that starts with S (secret key)", () => {
    expect(
      isValidStellarPublicKey(
        "SCZANGBA5RLMPI7JMILTKOMVHI3NZYDGRQV3SCYIMHZJHQHCQTJCHLHC",
      ),
    ).toBe(false);
  });

  it("rejects a key that is too short (55 chars after G)", () => {
    expect(isValidStellarPublicKey("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHON")).toBe(
      false,
    );
  });

  it("rejects a key that is too long (57 chars after G)", () => {
    expect(
      isValidStellarPublicKey(
        "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2HXX",
      ),
    ).toBe(false);
  });

  it("rejects a key containing lowercase characters", () => {
    expect(
      isValidStellarPublicKey(
        "Gbrpyhil2ci3fnq4bxlfmndlfjunpu2hy3zmfshonuceoasw7qc7ox2h",
      ),
    ).toBe(false);
  });

  it("rejects an HTML-like string that could cause XSS", () => {
    expect(isValidStellarPublicKey("<img src=x onerror=alert(1)>")).toBe(false);
  });

  it("rejects a key with invalid base32 characters (lowercase digits)", () => {
    expect(
      isValidStellarPublicKey(
        "G1111111111111111111111111111111111111111111111111111111",
      ),
    ).toBe(false);
  });
});

jest.mock("@creit-tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: jest.fn(),
    authModal: jest.fn(),
    disconnect: jest.fn(),
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useStellarWallet } = require("../useStellarWallet");

const VALID_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const INVALID_KEY = "not-a-valid-key";
const SHORT_KEY = "GSHORT";

describe("useStellarWallet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts in disconnected state", () => {
    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );
    expect(result.current.status).toBe("disconnected");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("sets connected state when wallet returns a valid public key", async () => {
    StellarWalletsKit.authModal.mockResolvedValue({ address: VALID_KEY });

    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.isConnected).toBe(true);
    expect(result.current.publicKey).toBe(VALID_KEY);
    expect(result.current.error).toBeNull();
  });

  it("sets error state when wallet returns an invalid public key", async () => {
    StellarWalletsKit.authModal.mockResolvedValue({ address: INVALID_KEY });

    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(result.current.error).toMatch(/invalid public key/i);
  });

  it("sets error state when wallet returns a shortened (xBull edge-case) key", async () => {
    StellarWalletsKit.authModal.mockResolvedValue({ address: SHORT_KEY });

    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
  });

  it("sets error state when wallet returns an HTML-like string", async () => {
    StellarWalletsKit.authModal.mockResolvedValue({
      address: "<script>alert('xss')</script>",
    });

    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
  });

  it("sets error state when authModal throws", async () => {
    StellarWalletsKit.authModal.mockRejectedValue(
      new Error("User cancelled"),
    );

    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe("User cancelled");
  });

  it("resets to disconnected state on disconnectWallet", async () => {
    StellarWalletsKit.authModal.mockResolvedValue({ address: VALID_KEY });

    const { result } = renderHook(() =>
      useStellarWallet(Networks.TESTNET),
    );

    await act(async () => {
      await result.current.connectWallet();
    });

    act(() => {
      result.current.disconnectWallet();
    });

    expect(result.current.status).toBe("disconnected");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
  });

  it("calls StellarWalletsKit.init once on mount", () => {
    renderHook(() => useStellarWallet(Networks.TESTNET));

    expect(StellarWalletsKit.init).toHaveBeenCalledTimes(1);
    expect(StellarWalletsKit.init).toHaveBeenCalledWith({
      network: Networks.TESTNET,
      modules: expect.any(Array),
    });
  });

  it("does not reinit if network prop is stable", () => {
    const { rerender } = renderHook(
      ({ network }) => useStellarWallet(network),
      { initialProps: { network: Networks.TESTNET } },
    );

    rerender({ network: Networks.TESTNET });

    expect(StellarWalletsKit.init).toHaveBeenCalledTimes(1);
  });

  it("calls StellarWalletsKit.disconnect on unmount (cleanup)", () => {
    const { unmount } = renderHook(() => useStellarWallet(Networks.TESTNET));

    unmount();

    expect(StellarWalletsKit.disconnect).toHaveBeenCalledTimes(1);
  });

  it("calls disconnect then reinit when network prop changes", () => {
    const { rerender } = renderHook(
      ({ network }: { network: Networks }) => useStellarWallet(network),
      { initialProps: { network: Networks.TESTNET } },
    );

    rerender({ network: "Public Global Stellar Network ; September 2015" as Networks });

    // First init on mount, second after the network-change cleanup
    expect(StellarWalletsKit.init).toHaveBeenCalledTimes(2);
    // Cleanup from the first effect fires before the second init
    expect(StellarWalletsKit.disconnect).toHaveBeenCalledTimes(1);
    expect(StellarWalletsKit.init).toHaveBeenLastCalledWith({
      network: "Public Global Stellar Network ; September 2015",
      modules: expect.any(Array),
    });
  });
});
