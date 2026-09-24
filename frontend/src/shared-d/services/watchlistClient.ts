/**
 * Client for the arena watchlist endpoints (#1402,
 * backend/src/routes/watchlist.ts). Watch/unwatch are idempotent on the
 * server, so a retried request here never duplicates or errors on an
 * already-applied change.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export class WatchlistRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly cause?: unknown) {
    super(message);
    this.name = "WatchlistRequestError";
  }
}

interface WatchlistResponse {
  watchedArenaIds: string[];
}

async function request(
  path: string,
  method: "GET" | "PUT" | "DELETE",
  token: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new WatchlistRequestError("Could not reach the watchlist endpoint.", undefined, error);
  }

  if (!response.ok) {
    throw new WatchlistRequestError(`Watchlist request failed (${response.status}).`, response.status);
  }

  const body = (await response.json()) as WatchlistResponse;
  return body.watchedArenaIds;
}

export function fetchWatchlist(token: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return request("/api/users/me/watchlist", "GET", token, fetchImpl);
}

export function watchArena(arenaId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return request(`/api/users/me/watchlist/${encodeURIComponent(arenaId)}`, "PUT", token, fetchImpl);
}

export function unwatchArena(arenaId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return request(`/api/users/me/watchlist/${encodeURIComponent(arenaId)}`, "DELETE", token, fetchImpl);
}
