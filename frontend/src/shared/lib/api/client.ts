/**
 * Unified Authenticated API Client (#1748).
 *
 * Provides typed HTTP verbs (GET, POST, PUT, PATCH, DELETE), automatic session
 * token injection, 401 refresh & single-retry handling, consistent error
 * envelope parsing (`ApiError`), request ID tracing, and SSE streaming helper.
 */

import {
  getSessionTokens,
  isAccessTokenExpiringSoon,
} from "../session/sessionStore";
import { refreshSession } from "../session/sessionClient";

const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/**
 * Standardized API Error parsing backend error envelopes.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code = "UNKNOWN_ERROR",
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export type QueryParams =
  | Record<string, string | number | boolean | null | undefined>
  | URLSearchParams;

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  params?: QueryParams;
  skipAuth?: boolean;
  requestId?: string;
}

export interface SseSubscriptionOptions {
  params?: QueryParams;
  onMessage: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  onOpen?: (event: Event) => void;
}

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function buildUrl(base: string, path: string, params?: QueryParams): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Handle relative vs absolute URLs
  const isAbsolute = path.startsWith("http://") || path.startsWith("https://");
  const fullUrl = isAbsolute ? path : `${base}${normalizedPath}`;

  if (!params) return fullUrl;

  const url = new URL(fullUrl, isAbsolute ? undefined : "http://localhost");
  if (params instanceof URLSearchParams) {
    params.forEach((v, k) => url.searchParams.append(k, v));
  } else {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
}

export class ApiClient {
  constructor(private readonly baseUrl: string = DEFAULT_API_BASE) {}

  /**
   * Resolves bearer token from session store, triggering a proactive
   * refresh if the token is close to expiry.
   */
  private async getAccessToken(): Promise<string | null> {
    if (typeof window === "undefined") return null;

    let tokens = getSessionTokens();
    if (!tokens) return null;

    if (isAccessTokenExpiringSoon()) {
      try {
        tokens = await refreshSession();
      } catch {
        tokens = getSessionTokens();
      }
    }

    return tokens?.accessToken ?? null;
  }

  private async parseErrorResponse(
    response: Response,
    requestId?: string,
  ): Promise<ApiError> {
    let code = "REQUEST_FAILED";
    let message = `Request failed (${response.status})`;
    let details: unknown = undefined;

    try {
      const data = (await response.json()) as {
        error?: string | { code?: string; message?: string; details?: unknown };
        message?: string;
        code?: string;
      };

      if (typeof data.error === "string") {
        message = data.error;
      } else if (data.error && typeof data.error === "object") {
        message = data.error.message ?? message;
        code = data.error.code ?? code;
        details = data.error.details;
      } else if (data.message) {
        message = data.message;
        code = data.code ?? code;
      }
    } catch {
      // Body was not JSON
    }

    return new ApiError(message, response.status, code, details, requestId);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const {
      body,
      params,
      headers: customHeaders = {},
      skipAuth = false,
      requestId = generateRequestId(),
      ...fetchInit
    } = options;

    const execute = async (tokenOverride?: string | null): Promise<Response> => {
      const headers = new Headers(customHeaders);
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/json");
      }
      headers.set("X-Request-ID", requestId);

      if (!skipAuth) {
        const token =
          tokenOverride !== undefined
            ? tokenOverride
            : await this.getAccessToken();
        if (token && !headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
      }

      let payload: BodyInit | null | undefined = undefined;
      if (body !== undefined) {
        if (
          typeof body === "string" ||
          body instanceof FormData ||
          body instanceof Blob ||
          body instanceof URLSearchParams
        ) {
          payload = body as BodyInit;
        } else {
          headers.set("Content-Type", "application/json");
          payload = JSON.stringify(body);
        }
      }

      const url = buildUrl(this.baseUrl, path, params);
      return fetch(url, {
        ...fetchInit,
        headers,
        body: payload,
      });
    };

    let response = await execute();

    // 401 handling: refresh session and retry once
    if (response.status === 401 && !skipAuth && typeof window !== "undefined") {
      try {
        const newTokens = await refreshSession();
        if (newTokens?.accessToken) {
          response = await execute(newTokens.accessToken);
        }
      } catch {
        // Refresh failed; proceed to error handling with original 401 response
      }
    }

    if (!response.ok) {
      throw await this.parseErrorResponse(response, requestId);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return (await response.json()) as T;
    }

    return (await response.text()) as unknown as T;
  }

  get<T>(path: string, options?: Omit<RequestOptions, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  delete<T>(path: string, options?: Omit<RequestOptions, "method">): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  /**
   * Helper for Server-Sent Events (SSE) subscriptions with token query authentication.
   */
  createEventSource(
    path: string,
    options: SseSubscriptionOptions,
  ): { close: () => void } {
    const tokens = getSessionTokens();
    const params = new URLSearchParams(
      options.params instanceof URLSearchParams
        ? options.params
        : (options.params as Record<string, string>) || {},
    );

    if (tokens?.accessToken && !params.has("token")) {
      params.set("token", tokens.accessToken);
    }

    const url = buildUrl(this.baseUrl, path, params);
    const eventSource = new EventSource(url);

    eventSource.onmessage = options.onMessage;
    if (options.onError) eventSource.onerror = options.onError;
    if (options.onOpen) eventSource.onopen = options.onOpen;

    return {
      close: () => {
        eventSource.close();
      },
    };
  }
}

export const apiClient = new ApiClient();
