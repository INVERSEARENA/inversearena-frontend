import type { NextFunction, Request, RequestHandler, Response } from "express";
import { apiError } from "../utils/apiError";

const DEFAULT_MAX_CONNECTIONS_PER_IP = 5;
const DEFAULT_MAX_CONNECTIONS_PER_ARENA = 100;

const connectionsByIp = new Map<string, number>();
const connectionsByArena = new Map<string, number>();

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function decrement(counter: Map<string, number>, key: string): void {
  const next = (counter.get(key) ?? 1) - 1;
  if (next <= 0) {
    counter.delete(key);
    return;
  }
  counter.set(key, next);
}

/**
 * Caps long-lived SSE subscriptions independently by client IP and arena.
 *
 * Counts are process-local because they represent file descriptors owned by
 * this process. A distributed limiter would count connections on other
 * instances and could reject traffic even when this process still has room.
 */
export function createSseConnectionLimitMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const arenaId = req.params.id ?? "unknown";
    const maxPerIp = readPositiveInt(
      "SSE_MAX_CONNECTIONS_PER_IP",
      DEFAULT_MAX_CONNECTIONS_PER_IP,
    );
    const maxPerArena = readPositiveInt(
      "SSE_MAX_CONNECTIONS_PER_ARENA",
      DEFAULT_MAX_CONNECTIONS_PER_ARENA,
    );

    if ((connectionsByIp.get(ip) ?? 0) >= maxPerIp) {
      next(
        apiError(
          429,
          "SSE_IP_CONNECTION_LIMIT",
          "Too many active event streams for this client",
        ),
      );
      return;
    }

    if ((connectionsByArena.get(arenaId) ?? 0) >= maxPerArena) {
      next(
        apiError(
          429,
          "SSE_ARENA_CONNECTION_LIMIT",
          "Too many active event streams for this arena",
        ),
      );
      return;
    }

    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    connectionsByArena.set(arenaId, (connectionsByArena.get(arenaId) ?? 0) + 1);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      decrement(connectionsByIp, ip);
      decrement(connectionsByArena, arenaId);
    };

    res.once("close", release);
    res.once("finish", release);
    next();
  };
}

/** Test-only reset for module-level process connection accounting. */
export function clearSseConnectionCounts(): void {
  connectionsByIp.clear();
  connectionsByArena.clear();
}
