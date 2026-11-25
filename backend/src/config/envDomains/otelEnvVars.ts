import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { decimal, flag, text, url } from "../envSpec";

export const otelEnvVars = {
  OTEL_SDK_DISABLED: {
    section: "OpenTelemetry",
    description:
      "Disable OpenTelemetry tracing SDK. Off by default when NODE_ENV=test unless explicitly set to false.",
    default: "false",
    schema: flag,
  },
  OTEL_SERVICE_NAME: {
    section: "OpenTelemetry",
    description: "Logical service name reported in OpenTelemetry resource attributes.",
    default: "inversearena-backend",
    schema: text,
  },
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    section: "OpenTelemetry",
    description:
      "Base OTLP HTTP endpoint for exporting traces (e.g. http://localhost:4318 for local Jaeger).",
    example: "http://localhost:4318",
    schema: url,
  },
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: {
    section: "OpenTelemetry",
    description:
      "Optional full OTLP HTTP traces endpoint override (takes precedence over OTEL_EXPORTER_OTLP_ENDPOINT).",
    example: "http://localhost:4318/v1/traces",
    schema: url,
  },
  OTEL_EXPORTER_OTLP_HEADERS: {
    section: "OpenTelemetry",
    description: "Optional comma-separated key=value headers sent with OTLP trace exports.",
    secret: true,
    schema: text,
  },
  OTEL_TRACES_SAMPLER: {
    section: "OpenTelemetry",
    description:
      "OpenTelemetry sampler strategy (parentbased_traceidratio, traceidratio, parentbased_always_on, always_on, always_off).",
    default: "parentbased_traceidratio",
    schema: z.enum([
      "always_on",
      "always_off",
      "traceidratio",
      "parentbased_always_on",
      "parentbased_always_off",
      "parentbased_traceidratio",
    ]),
  },
  OTEL_TRACES_SAMPLER_ARG: {
    section: "OpenTelemetry",
    description:
      "Sampling ratio (0.0 to 1.0) for ratio-based samplers. Use 0.1 in production for 10% sampling.",
    default: "1.0",
    schema: decimal(0, 1),
  },
  OTEL_SSE_TRACE_SAMPLE_RATE: {
    section: "OpenTelemetry",
    description:
      "Sampling ratio (0.0 to 1.0) for long-lived SSE stream requests. Defaults to 0 to avoid unbounded spans.",
    default: "0",
    schema: decimal(0, 1),
  },
} satisfies Record<string, EnvVarSpec>;
