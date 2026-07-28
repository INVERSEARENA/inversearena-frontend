// No static imports — dynamic requires after jest.doMock ensure @sentry/node
// is mocked before logger.ts loads it. jest.mock hoisting is unreliable with
// the ts-jest 29 + jest 30 combination used in this project.

describe("request context propagation (#661)", () => {
  let setTag: jest.Mock;
  let setExtras: jest.Mock;
  let captureException: jest.Mock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runWithRequestContext: (...args: any[]) => any;
  let getRequestId: () => string | undefined;
  let reportErrorToSentry: (err: Error) => void;

  beforeAll(() => {
    setTag = jest.fn();
    setExtras = jest.fn();
    captureException = jest.fn();

    jest.resetModules();
    jest.doMock("@sentry/node", () => ({
      withScope: (fn: (scope: { setTag: jest.Mock; setExtras: jest.Mock }) => void) => {
        fn({ setTag, setExtras });
      },
      captureException: (...args: unknown[]) => captureException(...args),
    }));

    const rc = require("../src/utils/requestContext");
    runWithRequestContext = rc.runWithRequestContext;
    getRequestId = rc.getRequestId;

    const log = require("../src/utils/logger");
    reportErrorToSentry = log.reportErrorToSentry;
  });

  afterAll(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  beforeEach(() => {
    setTag.mockClear();
    setExtras.mockClear();
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
