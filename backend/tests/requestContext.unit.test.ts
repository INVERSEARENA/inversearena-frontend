import * as Sentry from "@sentry/node";
import { runWithRequestContext, getRequestId } from "../src/utils/requestContext";
import { reportErrorToSentry } from "../src/utils/logger";

const setTag = jest.fn();
const setExtras = jest.fn();
const captureException = jest.fn();

beforeAll(() => {
  jest.spyOn(Sentry, "withScope").mockImplementation((fn) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as (scope: any) => void)({ setTag, setExtras });
    return undefined as ReturnType<typeof Sentry.withScope>;
  });
  jest.spyOn(Sentry, "captureException").mockImplementation(captureException);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe("request context propagation (#661)", () => {
  beforeEach(() => {
    setTag.mockClear();
    captureException.mockClear();
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
    // ...and clears once the scope exits.
    expect(getRequestId()).toBeUndefined();
  });

  it("tags Sentry events with the active request id", () => {
    runWithRequestContext({ requestId: "req-abc" }, () => {
      reportErrorToSentry(new Error("boom"));
    });
    expect(setTag).toHaveBeenCalledWith("requestId", "req-abc");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does not tag a request id when there is no active context", () => {
    reportErrorToSentry(new Error("boom"));
    expect(setTag).not.toHaveBeenCalledWith("requestId", expect.anything());
  });
});
