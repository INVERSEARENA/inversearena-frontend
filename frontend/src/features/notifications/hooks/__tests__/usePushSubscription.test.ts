import { renderHook, act } from "@testing-library/react";
import { usePushSubscription } from "../usePushSubscription";

describe("usePushSubscription (#1571)", () => {
  const originalServiceWorker = navigator.serviceWorker;
  const originalPushManager = (window as { PushManager?: unknown }).PushManager;
  const originalNotification = (window as { Notification?: unknown }).Notification;

  const setServiceWorker = (value: unknown) => {
    Object.defineProperty(navigator, "serviceWorker", { value, configurable: true });
  };

  afterEach(() => {
    setServiceWorker(originalServiceWorker);
    if (originalPushManager === undefined) {
      delete (window as { PushManager?: unknown }).PushManager;
    } else {
      (window as { PushManager?: unknown }).PushManager = originalPushManager;
    }
    if (originalNotification === undefined) {
      delete (window as { Notification?: unknown }).Notification;
    } else {
      (window as { Notification?: unknown }).Notification = originalNotification;
    }
    jest.restoreAllMocks();
  });

  it("reports unsupported when PushManager is missing", () => {
    setServiceWorker(undefined);
    const { result } = renderHook(() => usePushSubscription());
    expect(result.current.supported).toBe(false);
    expect(result.current.subscribed).toBe(false);
    expect(result.current.permission).toBe("unsupported");
  });

  it("detects an existing browser subscription on mount", async () => {
    const getSubscription = jest.fn().mockResolvedValue({ endpoint: "https://x/1" });
    setServiceWorker({
      ready: Promise.resolve({ pushManager: { getSubscription } }),
    });
    (window as { PushManager?: unknown }).PushManager = function PushManagerStub() {};
    (window as { Notification?: unknown }).Notification = {
      permission: "granted",
      requestPermission: jest.fn(),
    };

    const { result } = renderHook(() => usePushSubscription());
    expect(result.current.supported).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.subscribed).toBe(true);
  });

  it("errors clearly when VAPID is not configured", async () => {
    const getSubscription = jest.fn().mockResolvedValue(null);
    setServiceWorker({
      ready: Promise.resolve({ pushManager: { getSubscription } }),
    });
    (window as { PushManager?: unknown }).PushManager = function PushManagerStub() {};
    (window as { Notification?: unknown }).Notification = {
      permission: "default",
      requestPermission: jest.fn().mockResolvedValue("granted"),
    };

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.subscribe();
    });
    // NEXT_PUBLIC_VAPID_PUBLIC_KEY is unset in tests → not-configured error.
    expect(result.current.error).toMatch(/not configured|not supported/i);
  });
});
