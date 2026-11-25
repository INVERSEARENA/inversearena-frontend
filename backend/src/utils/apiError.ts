import type { ZodIssue } from "zod";

export interface ApiError {
  error: {
    code: string;
    message: string;
    issues?: ZodIssue[];
    /**
     * Field-level details for errors that carry remediation (#1689) — the
     * list of template fields that are stale, with what to do about each.
     */
    details?: unknown;
  };
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Optional field-level details (#1689). */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): HttpError {
  return new HttpError(status, code, message, details);
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
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_FAILED";
  }
}
