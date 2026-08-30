import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import {
  clearSseConnectionCounts,
  createSseConnectionLimitMiddleware,
} from "../src/middleware/sseConnectionLimit";

function request(ip: string, arenaId: string): Request {
  return {
    ip,
    params: { id: arenaId },
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function response(): Response & EventEmitter {
  return new EventEmitter() as Response & EventEmitter;
}

describe("SSE connection limiting (#1225)", () => {
  beforeEach(() => {
    clearSseConnectionCounts();
    process.env.SSE_MAX_CONNECTIONS_PER_IP = "1";
    process.env.SSE_MAX_CONNECTIONS_PER_ARENA = "1";
  });

  afterEach(() => {
    clearSseConnectionCounts();
    delete process.env.SSE_MAX_CONNECTIONS_PER_IP;
    delete process.env.SSE_MAX_CONNECTIONS_PER_ARENA;
  });

  it("rejects a second active stream from the same IP", () => {
    const middleware = createSseConnectionLimitMiddleware();
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    middleware(request("192.0.2.10", "arena-1"), response(), firstNext);
    middleware(request("192.0.2.10", "arena-2"), response(), secondNext);

    expect(firstNext).toHaveBeenCalledWith();
    expect(secondNext).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, code: "SSE_IP_CONNECTION_LIMIT" }),
    );
  });

  it("rejects a stream when the arena connection budget is full", () => {
    const middleware = createSseConnectionLimitMiddleware();
    const secondNext = jest.fn();

    middleware(request("192.0.2.11", "arena-1"), response(), jest.fn());
    middleware(request("192.0.2.12", "arena-1"), response(), secondNext);

    expect(secondNext).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, code: "SSE_ARENA_CONNECTION_LIMIT" }),
    );
  });

  it("releases both budgets exactly once when a response closes", () => {
    const middleware = createSseConnectionLimitMiddleware();
    const firstResponse = response();
    middleware(request("192.0.2.13", "arena-1"), firstResponse, jest.fn());

    firstResponse.emit("close");
    firstResponse.emit("finish");

    const next = jest.fn();
    middleware(request("192.0.2.13", "arena-1"), response(), next);
    expect(next).toHaveBeenCalledWith();
  });
});
