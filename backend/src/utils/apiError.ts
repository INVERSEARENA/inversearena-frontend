import type { ZodIssue } from "zod";

export interface ApiError {
  error: {
    code: string;
    message: string;
    issues?: ZodIssue[];
  };
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function apiError(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

export function defaultErrorCode(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 410:
      return "GONE";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_FAILED";
  }
}
