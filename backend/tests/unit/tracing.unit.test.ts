import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import {
  buildSampler,
  flushTracing,
  isSseSpanRequest,
  isTracingEnabled,
  initTracing,
  shutdownTracing,
  SseAwareSampler,
} from "../../src/tracing";
import { setSorobanSpanLedger, withSorobanRpcSpan } from "../../src/utils/sorobanTracing";
import {
  injectTraceContext,
  TX_CONFIRM_QUEUE,
  withBullMqConsumerSpan,
  withBullMqProducerSpan,
} from "../../src/queues/txQueue";
import { activeTraceContext, reportErrorToSentry } from "../../src/utils/logger";

describe("OpenTelemetry tracing (#1844)", () => {
  let exporter: InMemorySpanExporter;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    initTracing({
      force: true,
      config: {
        NODE_ENV: "test",
        OTEL_SDK_DISABLED: "false",
        OTEL_TRACES_SAMPLER: "always_on",
      },
      traceExporter: exporter,
    });
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await shutdownTracing();
    trace.disable();
    propagation.disable();
  });

  describe("isTracingEnabled", () => {
    it("is off by default in test environment", () => {
      expect(isTracingEnabled({ NODE_ENV: "test" })).toBe(false);
    });

    it("enables tracing in test environment when OTEL_SDK_DISABLED=false", () => {
      expect(isTracingEnabled({ NODE_ENV: "test", OTEL_SDK_DISABLED: "false" })).toBe(true);
    });

    it("disables tracing when OTEL_SDK_DISABLED=true in any environment", () => {
      expect(isTracingEnabled({ NODE_ENV: "production", OTEL_SDK_DISABLED: "true" })).toBe(false);
      expect(isTracingEnabled({ NODE_ENV: "development", OTEL_SDK_DISABLED: "1" })).toBe(false);
    });

    it("is enabled by default in development and production", () => {
      expect(isTracingEnabled({ NODE_ENV: "development" })).toBe(true);
      expect(isTracingEnabled({ NODE_ENV: "production" })).toBe(true);
    });
  });

  describe("SseAwareSampler", () => {
    it("drops long-lived SSE stream requests by path or Accept header", () => {
      const sampler = new SseAwareSampler(new AlwaysOnSampler(), 0);
      const dummyTraceId = "0af7651916cd43dd8448eb211c80319c";

      expect(
        isSseSpanRequest("GET /api/arenas/123/stream", SpanKind.SERVER, {
          "url.path": "/api/arenas/123/stream",
        }),
      ).toBe(true);

      const byPath = sampler.shouldSample(
        context.active(),
        dummyTraceId,
        "GET /api/arenas/123/stream",
        SpanKind.SERVER,
        { "url.path": "/api/arenas/123/stream" },
        [],
      );
      expect(byPath.decision).toBe(SamplingDecision.NOT_RECORD);

      const byHeader = sampler.shouldSample(
        context.active(),
        dummyTraceId,
        "GET /api/events",
        SpanKind.SERVER,
        { "http.request.header.accept": "text/event-stream" },
        [],
      );
      expect(byHeader.decision).toBe(SamplingDecision.NOT_RECORD);

      const normal = sampler.shouldSample(
        context.active(),
        dummyTraceId,
        "GET /api/arenas",
        SpanKind.SERVER,
        { "url.path": "/api/arenas" },
        [],
      );
      expect(normal.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    });

    it("builds sampler from OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG", () => {
      const sampler = buildSampler({
        OTEL_TRACES_SAMPLER: "always_off",
        OTEL_TRACES_SAMPLER_ARG: "0.1",
      });
      const res = sampler.shouldSample(
        context.active(),
        "0af7651916cd43dd8448eb211c80319c",
        "GET /api/arenas",
        SpanKind.SERVER,
        { "url.path": "/api/arenas" },
        [],
      );
      expect(res.decision).toBe(SamplingDecision.NOT_RECORD);
    });
  });

  describe("Soroban RPC manual spans", () => {
    it("records method, contract_id, function, and ledger without secrets", async () => {
      const result = await withSorobanRpcSpan(
        {
          method: "simulateTransaction",
          contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
          fn: "get_pool_config",
        },
        async (span) => {
          setSorobanSpanLedger(span, 42_123);
          return "ok";
        },
      );

      expect(result).toBe("ok");
      await flushTracing();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("soroban.rpc.simulateTransaction");
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes["rpc.system"]).toBe("soroban");
      expect(span.attributes["soroban.rpc.method"]).toBe("simulateTransaction");
      expect(span.attributes["soroban.contract_id"]).toBe(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      );
      expect(span.attributes["soroban.function"]).toBe("get_pool_config");
      expect(span.attributes["soroban.ledger"]).toBe(42_123);
      expect(span.attributes).not.toHaveProperty("signedXdr");
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("records exceptions and ERROR status when RPC call fails", async () => {
      await expect(
        withSorobanRpcSpan({ method: "sendTransaction", fn: "payout" }, async () => {
          throw new Error("rpc timeout");
        }),
      ).rejects.toThrow("rpc timeout");

      await flushTracing();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0]!.status.message).toBe("rpc timeout");
      expect(spans[0]!.events.some((e) => e.name === "exception")).toBe(true);
    });
  });

  describe("BullMQ trace context propagation", () => {
    it("links producer and consumer spans across job data", async () => {
      let jobData: { transactionId: string; _traceContext?: Record<string, string> } = {
        transactionId: "tx-123",
      };

      await withBullMqProducerSpan(TX_CONFIRM_QUEUE, "confirm", "tx-123", async () => {
        jobData = injectTraceContext({ transactionId: "tx-123" });
      });

      expect(jobData._traceContext).toBeDefined();
      expect(jobData._traceContext?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      await withBullMqConsumerSpan(
        TX_CONFIRM_QUEUE,
        { id: "tx-123", name: "confirm", data: jobData, attemptsMade: 1 },
        async () => "confirmed",
      );

      await flushTracing();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      const [producer, consumer] = spans;
      expect(producer!.kind).toBe(SpanKind.PRODUCER);
      expect(consumer!.kind).toBe(SpanKind.CONSUMER);
      expect(consumer!.spanContext().traceId).toBe(producer!.spanContext().traceId);
      expect(consumer!.parentSpanContext?.spanId).toBe(producer!.spanContext().spanId);
    });
  });

  describe("Logger and Sentry trace correlation", () => {
    it("exposes active traceId and spanId to logger and Sentry scope", async () => {
      const tracer = trace.getTracer("test");
      await tracer.startActiveSpan("test.operation", async (span) => {
        const ctx = activeTraceContext();
        expect(ctx).toBeDefined();
        expect(ctx!.traceId).toBe(span.spanContext().traceId);
        expect(ctx!.spanId).toBe(span.spanContext().spanId);

        // Verify reportErrorToSentry runs without error while trace context is active
        expect(() => reportErrorToSentry(new Error("boom"), { arenaId: "arena-1" })).not.toThrow();
        span.end();
      });

      expect(activeTraceContext()).toBeUndefined();
    });
  });
});
