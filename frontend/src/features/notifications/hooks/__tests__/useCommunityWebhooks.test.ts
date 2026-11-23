import { act, renderHook, waitFor } from "@testing-library/react";
import { useCommunityWebhooks } from "../useCommunityWebhooks";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("useCommunityWebhooks (#1735)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.setItem("access_token", "host-token");
    global.fetch = jest.fn() as unknown as typeof fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  it("loads, adds and announces host community webhooks", async () => {
    const webhook = {
      id: "webhook-1",
      arenaId: "arena-1",
      name: "Community",
      urlMasked: "https://discord.com/api/…",
      active: true,
      createdAt: "2026-11-20T12:00:00.000Z",
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse(webhook, 201))
      .mockResolvedValueOnce(jsonResponse({ items: [webhook] }))
      .mockResolvedValueOnce(jsonResponse({ delivered: 1, failed: 0, retrying: 0, skipped: 0 }, 202));

    const { result } = renderHook(() => useCommunityWebhooks("arena-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addWebhook("https://discord.com/api/webhooks/123/abc", "Community");
    });
    expect(result.current.webhooks).toEqual([webhook]);

    let dispatch: Awaited<ReturnType<typeof result.current.announce>> | undefined;
    await act(async () => {
      dispatch = await result.current.announce("Round 3 is live");
    });
    expect(dispatch).toMatchObject({ delivered: 1 });
    const announceCall = (global.fetch as jest.Mock).mock.calls[3];
    expect(announceCall[0]).toContain("/api/arenas/arena-1/announcements");
    expect(JSON.parse(announceCall[1].body)).toEqual({ title: "Round 3 is live" });
  });
});
