import { runWithRequestContext, getRequestId } from "../src/utils/requestContext";
import { reportErrorToSentry } from "../src/utils/logger";

const mockScope = { setTag: jest.fn(), setExtras: jest.fn() };

jest.mock("@sentry/node", () => ({
  withScope: jest.fn((fn: (scope: typeof mockScope) => void) => fn(mockScope)),
  captureException: jest.fn(),
}));

describe("request context propagation (#661)", () => {
  beforeEach(() => {
    mockScope.setTag.mockClear();
    mockScope.setExtras.mockClear();
    const Sentry = require("@sentry/node");
    Sentry.withScope.mockClear();
    Sentry.captureException.mockClear();
  });

  it("has no request id outside a request scope", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("exposes the request id within the scope, including across awaits", async () => {
    await runWithRequestContext({ requestId: "req-123" }, async () => {
      expect(getRequestId()).toBe("req-123");
      await Promise.resolve();
      expect(getRequestId()).toBe("req-123");
    });
    expect(getRequestId()).toBeUndefined();
  });

  it("tags Sentry events with the active request id", () => {
    runWithRequestContext({ requestId: "req-abc" }, () => {
      reportErrorToSentry(new Error("boom"));
    });
    expect(mockScope.setTag).toHaveBeenCalledWith("requestId", "req-abc");
    const Sentry = require("@sentry/node");
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not tag a request id when there is no active context", () => {
    reportErrorToSentry(new Error("boom"));
    expect(mockScope.setTag).not.toHaveBeenCalledWith("requestId", expect.anything());
  });
});
