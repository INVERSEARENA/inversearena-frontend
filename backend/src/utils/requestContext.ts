import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context propagated via AsyncLocalStorage (#661).
 *
 * Lets any code reached during a request — services, repositories, error
 * reporting — read the correlation id without threading it through every call,
 * so logs and Sentry events can be tied back to the originating HTTP request.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
