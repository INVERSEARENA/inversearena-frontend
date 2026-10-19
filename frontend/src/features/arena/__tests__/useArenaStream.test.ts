import { renderHook, waitFor } from "@testing-library/react";
import { useArenaStream } from "../useArenaStream";

describe("useArenaStream", () => {
  let mockEventSource: {
    close: jest.Mock;
    addEventListener: jest.Mock;
    onopen: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
    dispatchEvent: (event: Event) => void;
  };

  beforeEach(() => {
    mockEventSource = {
      close: jest.fn(),
      addEventListener: jest.fn(),
      onopen: null,
      onerror: null,
      dispatchEvent: jest.fn(),
    };

    // Mock EventSource globally
    (global as any).EventSource = jest.fn(() => mockEventSource);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (global as any).EventSource;
  });

  it("initializes with idle status when no arenaId", () => {
    const { result } = renderHook(() => useArenaStream(""));

    expect(result.current.status).toBe("idle");
    expect(result.current.snapshot).toBeNull();
    expect(result.current.feed).toEqual([]);
  });

  it("connects to EventSource when arenaId is provided", () => {
    renderHook(() => useArenaStream("arena-123"));

    expect(global.EventSource).toHaveBeenCalledWith(
      "/api/arenas/arena-123/stream",
    );
  });

  it("handles valid snapshot event", async () => {
    const { result } = renderHook(() => useArenaStream("arena-123"));

    // Trigger onopen
    if (mockEventSource.onopen) {
      mockEventSource.onopen(new Event("open"));
    }

    await waitFor(() => expect(result.current.status).toBe("connected"));

    // Simulate valid snapshot event
    const snapshotEvent = new MessageEvent("snapshot", {
      data: JSON.stringify({
        type: "snapshot",
        arenaId: "arena-123",
        sequence: 1,
        createdAt: "2026-08-26T00:00:00Z",
        payload: {
          arenaId: "arena-123",
          currentRound: 1,
          playerCount: 10,
          survivorCount: 8,
          status: "ACTIVE",
          recentEliminations: [],
          lastRoundState: null,
        },
      }),
    });

    // Get the message handler
    const messageHandler = mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];

    if (messageHandler) {
      messageHandler(snapshotEvent);
    }

    await waitFor(() => {
      expect(result.current.snapshot).not.toBeNull();
      expect(result.current.snapshot?.playerCount).toBe(10);
    });
  });

  it("handles malformed JSON gracefully without breaking stream", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const { result } = renderHook(() => useArenaStream("arena-123"));

    if (mockEventSource.onopen) {
      mockEventSource.onopen(new Event("open"));
    }

    await waitFor(() => expect(result.current.status).toBe("connected"));

    // Simulate malformed JSON event
    const malformedEvent = new MessageEvent("snapshot", {
      data: "{invalid json}",
    });

    const messageHandler = mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];

    if (messageHandler) {
      messageHandler(malformedEvent);
    }

    // Should log error but not crash
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse SSE event data"),
        expect.any(Error),
        expect.any(String),
        expect.any(String),
      );
    });

    // Status should still be connected (not reconnecting)
    expect(result.current.status).toBe("connected");

    consoleSpy.mockRestore();
  });

  it("handles invalid event schema gracefully", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const { result } = renderHook(() => useArenaStream("arena-123"));

    if (mockEventSource.onopen) {
      mockEventSource.onopen(new Event("open"));
    }

    await waitFor(() => expect(result.current.status).toBe("connected"));

    // Simulate event with missing required fields
    const invalidEvent = new MessageEvent("snapshot", {
      data: JSON.stringify({
        type: "snapshot",
        // Missing arenaId, sequence, createdAt
        payload: { some: "data" },
      }),
    });

    const messageHandler = mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];

    if (messageHandler) {
      messageHandler(invalidEvent);
    }

    // Should log error but not crash
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid ArenaStreamEvent shape"),
        expect.any(Object),
      );
    });

    // Status should still be connected
    expect(result.current.status).toBe("connected");

    consoleSpy.mockRestore();
  });

  it("handles invalid event type gracefully", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const { result } = renderHook(() => useArenaStream("arena-123"));

    if (mockEventSource.onopen) {
      mockEventSource.onopen(new Event("open"));
    }

    await waitFor(() => expect(result.current.status).toBe("connected"));

    // Simulate event with invalid type
    const invalidEvent = new MessageEvent("snapshot", {
      data: JSON.stringify({
        type: "invalid_type",
        arenaId: "arena-123",
        sequence: 1,
        createdAt: "2026-08-26T00:00:00Z",
        payload: {},
      }),
    });

    const messageHandler = mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];

    if (messageHandler) {
      messageHandler(invalidEvent);
    }

    // Should log error but not crash
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid ArenaStreamEvent shape"),
        expect.any(Object),
      );
    });

    expect(result.current.status).toBe("connected");

    consoleSpy.mockRestore();
  });

  it("handles truncated/partial JSON gracefully", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const { result } = renderHook(() => useArenaStream("arena-123"));

    if (mockEventSource.onopen) {
      mockEventSource.onopen(new Event("open"));
    }

    await waitFor(() => expect(result.current.status).toBe("connected"));

    // Simulate truncated JSON
    const truncatedEvent = new MessageEvent("snapshot", {
      data: '{"type":"snapshot","arenaId":"arena-123"',
    });

    const messageHandler = mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];

    if (messageHandler) {
      messageHandler(truncatedEvent);
    }

    // Should log error but not crash
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse SSE event data"),
        expect.any(Error),
        expect.any(String),
        expect.any(String),
      );
    });

    // Stream should stay open
    expect(result.current.status).toBe("connected");

    consoleSpy.mockRestore();
  });

  it("handles empty event data gracefully", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const { result } = renderHook(() => useArenaStream("arena-123"));

    if (mockEventSource.onopen) {
      mockEventSource.onopen(new Event("open"));
    }

    await waitFor(() => expect(result.current.status).toBe("connected"));

    // Simulate empty data
    const emptyEvent = new MessageEvent("snapshot", {
      data: "",
    });

    const messageHandler = mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];

    if (messageHandler) {
      messageHandler(emptyEvent);
    }

    // Should log error but not crash
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse SSE event data"),
        expect.any(Error),
        expect.any(String),
        expect.any(String),
      );
    });

    expect(result.current.status).toBe("connected");

    consoleSpy.mockRestore();
  });

  // ── Semantic version ordering (#1500) ───────────────────────────────────

  function dispatchSnapshot(
    handler: ((event: MessageEvent<string>) => void) | undefined,
    fields: Record<string, unknown>,
    payloadOverrides: Record<string, unknown> = {},
  ): void {
    handler?.(
      new MessageEvent("snapshot", {
        data: JSON.stringify({
          type: "snapshot",
          arenaId: "arena-123",
          sequence: 1,
          createdAt: "2026-08-26T00:00:00Z",
          payload: {
            arenaId: "arena-123",
            currentRound: 1,
            playerCount: 10,
            survivorCount: 8,
            status: "ACTIVE",
            recentEliminations: [],
            lastRoundState: null,
            ...payloadOverrides,
          },
          ...fields,
        }),
      }),
    );
  }

  function snapshotHandler(): ((event: MessageEvent<string>) => void) | undefined {
    return mockEventSource.addEventListener.mock.calls.find(
      (call) => call[0] === "snapshot",
    )?.[1];
  }

  it("applies versioned snapshots and rejects duplicates and out-of-order versions", async () => {
    const { result } = renderHook(() => useArenaStream("arena-123"));
    const handler = snapshotHandler();

    dispatchSnapshot(handler, { sequence: 5, version: 3, previousVersion: 2 });
    await waitFor(() => expect(result.current.snapshot?.playerCount).toBe(10));

    // Duplicate frame (same sequence) — rejected by the sequence gate.
    dispatchSnapshot(handler, { sequence: 5, version: 3, previousVersion: 2 }, { playerCount: 99 });
    // Higher sequence but an already-applied version — rejected by version.
    dispatchSnapshot(handler, { sequence: 6, version: 3, previousVersion: 2 }, { playerCount: 42 });

    await waitFor(() => expect(result.current.snapshot?.playerCount).toBe(10));

    // Contiguous next version applies normally.
    dispatchSnapshot(handler, { sequence: 7, version: 4, previousVersion: 3 }, { playerCount: 11 });
    await waitFor(() => expect(result.current.snapshot?.playerCount).toBe(11));
  });

  it("requests a full snapshot after a detected version gap", async () => {
    const { result } = renderHook(() => useArenaStream("arena-123"));
    const handler = snapshotHandler();

    dispatchSnapshot(handler, { sequence: 5, version: 2, previousVersion: 1 });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    // Version 5 links to 4, but we applied 2 — at least two versions were missed.
    dispatchSnapshot(handler, { sequence: 9, version: 5, previousVersion: 4 }, { playerCount: 42 });

    await waitFor(() => expect(result.current.resyncCount).toBe(1));
    // Reconnects with ?resync=1 so the server ignores the stale cursor.
    expect(global.EventSource).toHaveBeenLastCalledWith(
      "/api/arenas/arena-123/stream?resync=1",
    );
    // The gap snapshot was NOT applied — state still reflects version 2.
    expect(result.current.snapshot?.playerCount).toBe(10);
  });

  it("accepts the authoritative snapshot after a resync", async () => {
    const { result } = renderHook(() => useArenaStream("arena-123"));

    let handler = snapshotHandler();
    dispatchSnapshot(handler, { sequence: 5, version: 2, previousVersion: 1 });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    dispatchSnapshot(handler, { sequence: 9, version: 5, previousVersion: 4 }, { playerCount: 42 });
    await waitFor(() => expect(result.current.resyncCount).toBe(1));

    // The reconnect registered a fresh set of listeners.
    handler = snapshotHandler();
    dispatchSnapshot(handler, { sequence: 1, version: 5, previousVersion: 4 }, { playerCount: 7 });

    await waitFor(() => expect(result.current.snapshot?.playerCount).toBe(7));
    expect(result.current.resyncCount).toBe(1); // no second resync
  });

  it("adopts a new instanceId after a server restart instead of dropping the stream", async () => {
    const { result } = renderHook(() => useArenaStream("arena-123"));
    const handler = snapshotHandler();

    dispatchSnapshot(handler, { sequence: 5, version: 4, previousVersion: 3, instanceId: "instance-a" });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    // Restarted server: sequences and versions reset but the client is live.
    dispatchSnapshot(
      handler,
      { sequence: 1, version: 1, previousVersion: null, instanceId: "instance-b" },
      { playerCount: 3 },
    );

    await waitFor(() => expect(result.current.snapshot?.playerCount).toBe(3));
    expect(result.current.resyncCount).toBe(0);
  });
});
