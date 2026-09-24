import { renderHook, waitFor, act } from "@testing-library/react";
import { useServerTimeSync } from "../useServerTimeSync";
import { fetchServerTimeOffsetMs } from "../../services/serverTimeClient";

jest.mock("../../services/serverTimeClient", () => ({
  fetchServerTimeOffsetMs: jest.fn(),
}));

const mockedFetchOffset = fetchServerTimeOffsetMs as jest.MockedFunction<typeof fetchServerTimeOffsetMs>;

describe("useServerTimeSync", () => {
  beforeEach(() => {
    mockedFetchOffset.mockReset();
    jest.spyOn(document, "hidden", "get").mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("syncs on mount and reports isSynced true", async () => {
    mockedFetchOffset.mockResolvedValue(5000);

    const { result } = renderHook(() => useServerTimeSync());

    await waitFor(() => expect(result.current.isSynced).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it("applies the offset in getServerNow", async () => {
    mockedFetchOffset.mockResolvedValue(5000);
    const { result } = renderHook(() => useServerTimeSync());

    await waitFor(() => expect(result.current.isSynced).toBe(true));

    const before = Date.now();
    const serverNow = result.current.getServerNow();
    expect(serverNow).toBeGreaterThanOrEqual(before + 5000 - 50);
    expect(serverNow).toBeLessThanOrEqual(before + 5000 + 50);
  });

  it("sets an error and keeps isSynced false when the initial sync fails", async () => {
    mockedFetchOffset.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useServerTimeSync());

    await waitFor(() => expect(result.current.error).toBe("offline"));
    expect(result.current.isSynced).toBe(false);
  });

  it("keeps the previous offset after a later failed resync", async () => {
    mockedFetchOffset.mockResolvedValueOnce(3000);
    const { result } = renderHook(() => useServerTimeSync());
    await waitFor(() => expect(result.current.isSynced).toBe(true));

    mockedFetchOffset.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => {
      await result.current.resync();
    });

    expect(result.current.error).toBe("timeout");
    const before = Date.now();
    expect(result.current.getServerNow()).toBeGreaterThanOrEqual(before + 3000 - 50);
  });

  it("clears a previous error once a resync succeeds again", async () => {
    mockedFetchOffset.mockRejectedValueOnce(new Error("timeout"));
    const { result } = renderHook(() => useServerTimeSync());
    await waitFor(() => expect(result.current.error).toBe("timeout"));

    mockedFetchOffset.mockResolvedValueOnce(1000);
    await act(async () => {
      await result.current.resync();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isSynced).toBe(true);
  });

  it("exposes a manual resync function that re-fetches immediately", async () => {
    mockedFetchOffset.mockResolvedValue(1000);
    const { result } = renderHook(() => useServerTimeSync());
    await waitFor(() => expect(result.current.isSynced).toBe(true));

    mockedFetchOffset.mockClear();
    await act(async () => {
      await result.current.resync();
    });

    expect(mockedFetchOffset).toHaveBeenCalledTimes(1);
  });

  it("resyncs immediately when the tab regains visibility (covers sleep/reconnect)", async () => {
    const hiddenSpy = jest.spyOn(document, "hidden", "get").mockReturnValue(false);
    mockedFetchOffset.mockResolvedValue(1000);

    const { result } = renderHook(() => useServerTimeSync());
    await waitFor(() => expect(result.current.isSynced).toBe(true));

    // Simulate the device sleeping (tab backgrounded) — Date.now effectively
    // jumps forward on wake, which is exactly the scenario a resync-on-
    // regain guards against, since the stale offset alone wouldn't account
    // for the elapsed background time.
    hiddenSpy.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    mockedFetchOffset.mockClear();
    mockedFetchOffset.mockResolvedValue(9000);

    hiddenSpy.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(mockedFetchOffset).toHaveBeenCalled());
  });
});
