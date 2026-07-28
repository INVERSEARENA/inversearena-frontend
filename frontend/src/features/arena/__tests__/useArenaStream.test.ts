/**
 * Tests for the SSE staleness watchdog (#1133).
 *
 * The backend sends a raw SSE comment frame every ~15s as a transport-level
 * keepalive. Comment frames never dispatch a JS event on EventSource, so a
 * connection that's silently died (no TCP FIN/RST — e.g. a NAT/proxy black
 * hole) would otherwise sit unnoticed for up to the OS keepalive timeout.
 * The hook instead tracks the last time it observed *any* real event and
 * force-reconnects once 60s pass without one.
 */
import { renderHook, act } from "@testing-library/react";
import { useArenaStream } from "../useArenaStream";

type Listener = (event: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: EventListener): void {
    (this.listeners[type] ??= []).push(cb as Listener);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

const SNAPSHOT_PAYLOAD = {
  arenaId: "arena-1",
  currentRound: 1,
  playerCount: 4,
  survivorCount: 4,
  status: "active",
  recentEliminations: [],
  lastRoundState: null,
};

function emitSnapshot(source: MockEventSource, sequence = 1): void {
  source.emit("snapshot", {
    type: "snapshot",
    arenaId: "arena-1",
    payload: SNAPSHOT_PAYLOAD,
    sequence,
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  MockEventSource.instances = [];
  (global as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useArenaStream — staleness watchdog", () => {
  it("force-reconnects once 60s pass with no observed event", () => {
    renderHook(() => useArenaStream("arena-1"));

    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0]!;

    act(() => {
      first.emitOpen();
    });

    // Advance past the 60s staleness window (in 10s watchdog ticks).
    act(() => {
      jest.advanceTimersByTime(70_000);
    });

    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("does not reconnect when real events keep arriving within the window", () => {
    renderHook(() => useArenaStream("arena-1"));
    const first = MockEventSource.instances[0]!;

    act(() => {
      first.emitOpen();
    });

    // Emit a snapshot every 30s, well under the 60s threshold, for 90s total.
    for (let i = 0; i < 3; i++) {
      act(() => {
        jest.advanceTimersByTime(30_000);
        emitSnapshot(first, i);
      });
    }

    expect(first.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("stops watchdog reconnects after unmount", () => {
    const { unmount } = renderHook(() => useArenaStream("arena-1"));
    const first = MockEventSource.instances[0]!;

    act(() => {
      first.emitOpen();
    });

    unmount();

    act(() => {
      jest.advanceTimersByTime(120_000);
    });

    // No further connections were opened once the effect tore down.
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("resets the watchdog baseline on a fresh connection so it doesn't reconnect immediately", () => {
    renderHook(() => useArenaStream("arena-1"));
    const first = MockEventSource.instances[0]!;

    act(() => {
      first.emitOpen();
    });

    act(() => {
      jest.advanceTimersByTime(70_000);
    });

    expect(MockEventSource.instances).toHaveLength(2);
    const second = MockEventSource.instances[1]!;

    // A short additional delay shouldn't immediately trigger yet another
    // reconnect — the new attempt gets its own fresh 60s budget.
    act(() => {
      jest.advanceTimersByTime(20_000);
    });

    expect(second.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(2);
  });
});
