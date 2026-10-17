import { renderHook, waitFor, act } from "@testing-library/react";
import { useWatchlist } from "../useWatchlist";
import { fetchWatchlist, watchArena, unwatchArena } from "../../services/watchlistClient";

jest.mock("../../services/watchlistClient", () => ({
  fetchWatchlist: jest.fn(),
  watchArena: jest.fn(),
  unwatchArena: jest.fn(),
}));

const mockedFetchWatchlist = fetchWatchlist as jest.MockedFunction<typeof fetchWatchlist>;
const mockedWatchArena = watchArena as jest.MockedFunction<typeof watchArena>;
const mockedUnwatchArena = unwatchArena as jest.MockedFunction<typeof unwatchArena>;

describe("useWatchlist", () => {
  beforeEach(() => {
    mockedFetchWatchlist.mockReset();
    mockedWatchArena.mockReset();
    mockedUnwatchArena.mockReset();
  });

  it("does not fetch when there is no token", () => {
    renderHook(() => useWatchlist(null));
    expect(mockedFetchWatchlist).not.toHaveBeenCalled();
  });

  it("loads the watchlist when a token is present", async () => {
    mockedFetchWatchlist.mockResolvedValue(["arena-1"]);

    const { result } = renderHook(() => useWatchlist("token"));

    await waitFor(() => expect(result.current.watchedArenaIds).toEqual(["arena-1"]));
    expect(result.current.isWatched("arena-1")).toBe(true);
    expect(result.current.isWatched("arena-2")).toBe(false);
  });

  it("sets an error when the initial load fails", async () => {
    mockedFetchWatchlist.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useWatchlist("token"));

    await waitFor(() => expect(result.current.error).toBe("offline"));
  });

  it("toggling an unwatched arena calls watchArena and reconciles with the server result", async () => {
    mockedFetchWatchlist.mockResolvedValue([]);
    mockedWatchArena.mockResolvedValue(["arena-1"]);

    const { result } = renderHook(() => useWatchlist("token"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggle("arena-1");
    });

    expect(mockedWatchArena).toHaveBeenCalledWith("arena-1", "token");
    expect(result.current.watchedArenaIds).toEqual(["arena-1"]);
  });

  it("toggling a watched arena calls unwatchArena", async () => {
    mockedFetchWatchlist.mockResolvedValue(["arena-1"]);
    mockedUnwatchArena.mockResolvedValue([]);

    const { result } = renderHook(() => useWatchlist("token"));
    await waitFor(() => expect(result.current.watchedArenaIds).toEqual(["arena-1"]));

    await act(async () => {
      await result.current.toggle("arena-1");
    });

    expect(mockedUnwatchArena).toHaveBeenCalledWith("arena-1", "token");
    expect(result.current.watchedArenaIds).toEqual([]);
  });

  it("shows the optimistic state immediately, before the request resolves", async () => {
    mockedFetchWatchlist.mockResolvedValue([]);
    let resolveWatch!: (value: string[]) => void;
    mockedWatchArena.mockReturnValue(
      new Promise((resolve) => {
        resolveWatch = resolve;
      }),
    );

    const { result } = renderHook(() => useWatchlist("token"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      void result.current.toggle("arena-1");
    });

    expect(result.current.isWatched("arena-1")).toBe(true);

    await act(async () => {
      resolveWatch(["arena-1"]);
    });
  });

  it("rolls back the optimistic update when the toggle request fails", async () => {
    mockedFetchWatchlist.mockResolvedValue([]);
    mockedWatchArena.mockRejectedValue(new Error("server error"));

    const { result } = renderHook(() => useWatchlist("token"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggle("arena-1");
    });

    expect(result.current.isWatched("arena-1")).toBe(false);
    expect(result.current.error).toBe("server error");
  });

  it("setting an error and toggling without a token", async () => {
    const { result } = renderHook(() => useWatchlist(null));

    await act(async () => {
      await result.current.toggle("arena-1");
    });

    expect(result.current.error).toMatch(/sign in/i);
    expect(mockedWatchArena).not.toHaveBeenCalled();
  });
});
