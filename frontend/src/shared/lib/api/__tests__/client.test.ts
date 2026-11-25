import { ApiClient, ApiError } from "../client";
import * as sessionStore from "../../session/sessionStore";
import * as sessionClient from "../../session/sessionClient";

jest.mock("../../session/sessionStore", () => {
  const actual = jest.requireActual("../../session/sessionStore");
  return {
    ...actual,
    getSessionTokens: jest.fn(),
    isAccessTokenExpiringSoon: jest.fn(),
  };
});

jest.mock("../../session/sessionClient", () => {
  const actual = jest.requireActual("../../session/sessionClient");
  return {
    ...actual,
    refreshSession: jest.fn(),
  };
});

describe("ApiClient", () => {
  let client: ApiClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new ApiClient("http://api.test");
    originalFetch = global.fetch;
    jest.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("injects Authorization header and X-Request-ID on requests", async () => {
    jest.spyOn(sessionStore, "getSessionTokens").mockReturnValue({
      accessToken: "mock-token",
      refreshToken: "mock-refresh",
    });
    jest.spyOn(sessionStore, "isAccessTokenExpiringSoon").mockReturnValue(false);

    let capturedHeaders: Headers | undefined;
    global.fetch = jest.fn().mockImplementation((_url, init) => {
      capturedHeaders = new Headers(init.headers);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });

    const result = await client.get<{ ok: boolean }>("/test-path");

    expect(result).toEqual({ ok: true });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer mock-token");
    expect(capturedHeaders?.get("X-Request-ID")).toBeTruthy();
    expect(capturedHeaders?.get("Accept")).toBe("application/json");
  });

  it("handles 401 by calling refreshSession and retrying once", async () => {
    jest.spyOn(sessionStore, "getSessionTokens").mockReturnValue({
      accessToken: "expired-token",
      refreshToken: "mock-refresh",
    });
    jest.spyOn(sessionStore, "isAccessTokenExpiringSoon").mockReturnValue(false);

    const refreshSpy = jest.spyOn(sessionClient, "refreshSession").mockImplementation(async () => {
      return { accessToken: "new-token", refreshToken: "new-refresh" };
    });

    let callCount = 0;
    global.fetch = jest.fn().mockImplementation((_url, init) => {
      callCount++;
      const headers = new Headers(init.headers);
      if (callCount === 1) {
        expect(headers.get("Authorization")).toBe("Bearer expired-token");
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "Unauthorized", code: "UNAUTHORIZED" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }));
      }
      expect(headers.get("Authorization")).toBe("Bearer new-token");
      return Promise.resolve(new Response(JSON.stringify({ data: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });

    const result = await client.get<{ data: string }>("/protected");

    expect(result).toEqual({ data: "success" });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
  });

  it("throws ApiError with envelope details on error response", async () => {
    jest.spyOn(sessionStore, "getSessionTokens").mockReturnValue(null);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "ARENA_FULL",
            message: "This arena has reached capacity",
            details: { maxPlayers: 10 },
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(client.post("/join", { arenaId: "123" })).rejects.toThrow(ApiError);

    try {
      await client.post("/join", { arenaId: "123" });
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.code).toBe("ARENA_FULL");
      expect(apiErr.message).toBe("This arena has reached capacity");
      expect(apiErr.details).toEqual({ maxPlayers: 10 });
    }
  });

  it("handles abort signal properly", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockImplementation((_url, init) => {
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const reqPromise = client.get("/slow", { signal: controller.signal });
    controller.abort();

    await expect(reqPromise).rejects.toThrow("Aborted");
  });

  it("supports typed post, put, and delete with 204 handling", async () => {
    global.fetch = jest.fn().mockImplementation((url, init) => {
      if (init.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ method: init.method, body: JSON.parse(init.body) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const postRes = await client.post<{ method: string; body: { a: number } }>("/item", { a: 1 });
    expect(postRes).toEqual({ method: "POST", body: { a: 1 } });

    const deleteRes = await client.delete<void>("/item/1");
    expect(deleteRes).toBeUndefined();
  });
});
