/**
 * Regression for #1349: 5xx responses must not include raw internal
 * error messages; intentional 4xx HttpErrors still pass their message through.
 */
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "../src/middleware/errorHandler";
import { apiError } from "../src/utils/apiError";
import { logger } from "../src/utils/logger";

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as typeof res & Response;
}

function mockReq(): Request {
  return { id: "req-1349", url: "/api/pools", method: "POST", body: {} } as unknown as Request;
}

describe("errorHandler (#1349)", () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("replaces raw 5xx messages with a generic internal error", () => {
    const res = mockRes();
    errorHandler(
      new Error('insert into "pools" violates foreign key constraint'),
      mockReq(),
      res,
      (() => undefined) as NextFunction,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      },
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("passes through 4xx HttpError messages unchanged", () => {
    const res = mockRes();
    errorHandler(
      apiError(400, "BAD_REQUEST", "pool name is required"),
      mockReq(),
      res,
      (() => undefined) as NextFunction,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "pool name is required",
      },
    });
    expect(warnSpy).toHaveBeenCalled();
  });
});
