import { act, renderHook } from "@testing-library/react";

import { useSession } from "../useSession";
import { loginWithWallet, logoutSession, scheduleRefresh } from "@/shared/lib/session/sessionClient";
import { subscribeSession } from "@/shared/lib/session/sessionStore";
import { useWallet } from "../../hooks/useWallet";

jest.mock("../../hooks/useWallet", () => ({ useWallet: jest.fn() }));
jest.mock("@/shared/lib/session/sessionClient", () => ({
  loginWithWallet: jest.fn(async () => undefined),
  logoutSession: jest.fn(async () => undefined),
  scheduleRefresh: jest.fn(),
}));
jest.mock("@/shared/lib/session/sessionStore", () => ({
  getSessionState: jest.fn(() => ({
    status: "unauthenticated",
    walletAddress: null,
    expiresAt: 0,
    error: null,
  })),
  subscribeSession: jest.fn(() => () => undefined),
}));

const mockedUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;
const mockedLogin = loginWithWallet as jest.MockedFunction<typeof loginWithWallet>;
const mockedLogout = logoutSession as jest.MockedFunction<typeof logoutSession>;
const mockedSubscribe = subscribeSession as jest.MockedFunction<typeof subscribeSession>;

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("useSession", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseWallet.mockReturnValue({
      address: WALLET,
      network: "Test SDF Network ; September 2015" as never,
      signMessage: jest.fn(async () => "sig"),
      signTransaction: jest.fn(async () => "xdr"),
    } as never);
  });

  it("exposes status, login and logout and passes the wallet signers through", async () => {
    const { result } = renderHook(() => useSession());

    expect(result.current.status).toBe("unauthenticated");
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => {
      await result.current.login();
    });

    expect(mockedLogin).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: WALLET }),
      "Test SDF Network ; September 2015",
    );

    await act(async () => {
      await result.current.logout();
    });
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });

  it("refuses login while no wallet is connected", async () => {
    mockedUseWallet.mockReturnValue({ address: null } as never);
    const { result } = renderHook(() => useSession());

    await expect(result.current.login()).rejects.toThrow(/connect a wallet/i);
    expect(mockedLogin).not.toHaveBeenCalled();
  });

  it("follows state transitions published by the session store", () => {
    let notify!: (state: never) => void;
    mockedSubscribe.mockImplementation((listener) => {
      notify = listener as (state: never) => void;
      return () => undefined;
    });
    const { result } = renderHook(() => useSession());

    act(() => {
      notify({
        status: "authenticated",
        walletAddress: WALLET,
        expiresAt: Date.now() + 900_000,
        error: null,
      } as never);
    });

    expect(result.current.status).toBe("authenticated");
    expect(result.current.isAuthenticated).toBe(true);
    expect(scheduleRefresh).toHaveBeenCalled();
  });
});
