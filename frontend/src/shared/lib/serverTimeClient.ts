/**
 * Client for the signed server-time endpoint (#1401,
 * backend/src/services/serverTimeService.ts). Computes a clock offset
 * (serverTime - localTime) so a countdown can be kept accurate without
 * trusting the device's own clock, and re-fetches periodically so the
 * offset stays correct across sleep, clock skew drift, and reconnects.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export interface ServerTimeResponse {
  version: number;
  serverTimeMs: number;
  issuedAt: string;
  token: string;
}

export class ServerTimeFetchError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ServerTimeFetchError";
  }
}

/**
 * Fetches the current signed server time and returns the clock offset in
 * milliseconds: add this to `Date.now()` at any later moment to get an
 * estimate of the current server time, without re-fetching on every tick.
 */
export async function fetchServerTimeOffsetMs(fetchImpl: typeof fetch = fetch): Promise<number> {
  const requestStartedAt = Date.now();

  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}/api/arenas/time`);
  } catch (error) {
    throw new ServerTimeFetchError("Could not reach the server-time endpoint.", error);
  }

  if (!response.ok) {
    throw new ServerTimeFetchError(`Server-time endpoint returned ${response.status}.`);
  }

  const requestFinishedAt = Date.now();

  let body: ServerTimeResponse;
  try {
    body = (await response.json()) as ServerTimeResponse;
  } catch (error) {
    throw new ServerTimeFetchError("Server-time response was not valid JSON.", error);
  }

  if (typeof body.serverTimeMs !== "number") {
    throw new ServerTimeFetchError("Server-time response was missing serverTimeMs.");
  }

  // The server's reported time is as of some instant during the round
  // trip; splitting the difference against the midpoint of when the
  // request was sent and its response received is a simple, standard
  // correction for one-way network latency (NTP uses the same idea).
  const roundTripMs = requestFinishedAt - requestStartedAt;
  const estimatedRequestArrivalAtServer = requestStartedAt + roundTripMs / 2;

  return body.serverTimeMs - estimatedRequestArrivalAtServer;
}
