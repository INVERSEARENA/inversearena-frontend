import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useNotificationChannels,
  type ChannelPreferencesPayload,
} from "../useNotificationChannels";

const PAYLOAD: ChannelPreferencesPayload = {
  preferences: {
    userId: "user-1",
    emailEnabled: false,
    pushEnabled: true,
    telegramEnabled: false,
    discordEnabled: false,
    inAppEnabled: true,
    roundNotifications: true,
    payoutNotifications: true,
    eliminationNotifications: true,
    arenaAnnouncementNotifications: true,
  },
  channelPreferences: [{ eventType: "round", channel: "push", enabled: false }],
  links: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("useNotificationChannels (#1735)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.setItem("access_token", "test-token");
    global.fetch = jest.fn() as unknown as typeof fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  it("loads channel settings with the authenticated wallet token", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(PAYLOAD));

    const { result } = renderHook(() => useNotificationChannels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(PAYLOAD);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/users/me/notification-channels"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it("creates a one-time bot link code", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(
        jsonResponse({
          channel: "discord",
          code: "ABC12345",
          expiresAt: "2026-11-20T12:10:00.000Z",
          instructions: "Run /link ABC12345 in Discord.",
        }),
      );

    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      const code = await result.current.createLinkCode("discord");
      expect(code.code).toBe("ABC12345");
    });

    expect(global.fetch).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/users/me/notification-links/discord/code"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.current.linkCode?.instructions).toContain("/link ABC12345");
  });

  it("persists a per-event/per-channel preference", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockResolvedValueOnce(
        jsonResponse({
          preferences: PAYLOAD.preferences,
          channelPreferences: [{ eventType: "payout", channel: "telegram", enabled: false }],
        }),
      );

    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setChannelEvent("payout", "telegram", false);
    });

    const [, init] = (global.fetch as jest.Mock).mock.calls[1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      channelPreferences: [{ eventType: "payout", channel: "telegram", enabled: false }],
    });
    expect(result.current.data?.channelPreferences).toEqual([
      { eventType: "payout", channel: "telegram", enabled: false },
    ]);
  });
});
