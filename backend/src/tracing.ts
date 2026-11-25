/**
 * OpenTelemetry distributed tracing initialization (#1844).
 *
 * Must be imported before Express, Prisma, ioredis, Mongoose, or BullMQ
 * so module-level auto-instrumentation hooks attach before first use.
 *
 * Off by default when `NODE_ENV=test` unless `OTEL_SDK_DISABLED=false`.
 */
import type { Context, Link, Attributes } from "@opentelemetry/api";
import { SpanKind } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { MongooseInstrumentation } from "@opentelemetry/instrumentation-mongoose";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { env } from "./config/env";

export interface TracingEnvConfig {
  NODE_ENV?: string;
  OTEL_SDK_DISABLED?: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_TRACES_SAMPLER?: string;
  OTEL_TRACES_SAMPLER_ARG?: string;
  OTEL_SSE_TRACE_SAMPLE_RATE?: string;
}

const SSE_PATH_PATTERN = /\/arenas\/[^/]+\/stream(?:$|\?)|\/stream(?:$|\?)/;

function parseRatio(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const idx = entry.indexOf("=");
    if (idx <= 0) continue;
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Returns whether OpenTelemetry tracing should be initialized for the given
 * environment configuration. Disabled by default in `test` unless explicitly
 * opted in with `OTEL_SDK_DISABLED=false`.
 */
export function isTracingEnabled(config: TracingEnvConfig = env): boolean {
  const disabled = config.OTEL_SDK_DISABLED?.trim().toLowerCase();
  if (disabled === "true" || disabled === "1") return false;
  if (config.NODE_ENV === "test") {
    return disabled === "false" || disabled === "0";
  }
  return true;
}

/**
 * Checks whether an incoming HTTP span represents a long-lived SSE stream
 * request that should be sampled separately (dropped by default).
 */
export function isSseSpanRequest(
  spanName: string,
  spanKind: SpanKind,
  attributes: Attributes,
): boolean {
  if (spanKind !== SpanKind.SERVER) return false;
  const target =
    (typeof attributes["url.path"] === "string" && attributes["url.path"]) ||
    (typeof attributes["http.target"] === "string" && attributes["http.target"]) ||
    (typeof attributes["http.route"] === "string" && attributes["http.route"]) ||
    spanName;
  if (SSE_PATH_PATTERN.test(target)) return true;

  const acceptHeader = attributes["http.request.header.accept"];
  if (typeof acceptHeader === "string" && acceptHeader.includes("text/event-stream")) {
    return true;
  }
  if (Array.isArray(acceptHeader) && acceptHeader.some((v) => String(v).includes("text/event-stream"))) {
    return true;
  }
  return false;
}

/**
 * Sampler wrapper that applies a dedicated (default 0%) sampling policy to
 * long-lived SSE requests while delegating all other spans to the configured
 * base sampler.
 */
export class SseAwareSampler implements Sampler {
  private readonly sseSampler: Sampler;

  constructor(
    private readonly baseSampler: Sampler,
    sseSampleRate = 0,
  ) {
    this.sseSampler =
      sseSampleRate <= 0
        ? new AlwaysOffSampler()
        : sseSampleRate >= 1
          ? new AlwaysOnSampler()
          : new TraceIdRatioBasedSampler(sseSampleRate);
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (isSseSpanRequest(spanName, spanKind, attributes)) {
      return this.sseSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    }
    return this.baseSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `SseAwareSampler(${this.baseSampler.toString()})`;
  }
}

export function buildSampler(config: TracingEnvConfig = env): Sampler {
  const ratio = parseRatio(config.OTEL_TRACES_SAMPLER_ARG, 1.0);
  const sseRate = parseRatio(config.OTEL_SSE_TRACE_SAMPLE_RATE, 0);
  let base: Sampler;

  switch (config.OTEL_TRACES_SAMPLER) {
    case "always_on":
      base = new AlwaysOnSampler();
      break;
    case "always_off":
      base = new AlwaysOffSampler();
      break;
    case "traceidratio":
      base = new TraceIdRatioBasedSampler(ratio);
      break;
    case "parentbased_always_on":
      base = new ParentBasedSampler({ root: new AlwaysOnSampler() });
      break;
    case "parentbased_always_off":
      base = new ParentBasedSampler({ root: new AlwaysOffSampler() });
      break;
    case "parentbased_traceidratio":
    default:
      base = new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
      break;
  }

  return new SseAwareSampler(base, sseRate);
}

function buildTraceExporter(config: TracingEnvConfig): SpanExporter | undefined {
  const tracesEndpoint = config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const baseEndpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!tracesEndpoint && !baseEndpoint) return undefined;

  const url = tracesEndpoint ?? `${baseEndpoint!.replace(/\/+$/, "")}/v1/traces`;
  const headers = parseOtlpHeaders(config.OTEL_EXPORTER_OTLP_HEADERS);
  return new OTLPTraceExporter({ url, headers });
}

export interface InitTracingOptions {
  config?: TracingEnvConfig;
  traceExporter?: SpanExporter;
  spanProcessors?: SpanProcessor[];
  force?: boolean;
}

let sdkInstance: NodeSDK | null = null;

export function initTracing(options: InitTracingOptions = {}): NodeSDK | null {
  if (sdkInstance) return sdkInstance;

  const config = options.config ?? env;
  if (!options.force && !isTracingEnabled(config)) {
    return null;
  }

  const traceExporter = options.traceExporter ?? buildTraceExporter(config);
  const serviceName = config.OTEL_SERVICE_NAME?.trim() || "inversearena-backend";
  const environment = config.NODE_ENV?.trim() || "development";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    }),
    sampler: buildSampler(config),
    ...(traceExporter ? { traceExporter } : {}),
    ...(options.spanProcessors ? { spanProcessors: options.spanProcessors } : {}),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? "";
          return url === "/metrics" || url.startsWith("/metrics?");
        },
      }),
      new ExpressInstrumentation(),
      new IORedisInstrumentation(),
      new MongooseInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  sdkInstance = sdk;
  return sdk;
}

export async function flushTracing(): Promise<void> {
  const active = sdkInstance as (NodeSDK & { _tracerProvider?: { forceFlush(): Promise<void> } }) | null;
  await active?._tracerProvider?.forceFlush();
}

export async function shutdownTracing(): Promise<void> {
  const active = sdkInstance;
  if (!active) return;
  sdkInstance = null;
  await active.shutdown();
}

export function getTracingSdk(): NodeSDK | null {
  return sdkInstance;
}

// Auto-initialize when imported at process startup (server.ts).
if (isTracingEnabled(env)) {
  initTracing();
}
