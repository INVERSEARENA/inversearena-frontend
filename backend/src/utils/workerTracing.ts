import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const workerTracer = trace.getTracer("inversearena-backend.workers");

/**
 * Wraps a background worker run/batch in an OpenTelemetry span so all
 * downstream Prisma, Mongo, Redis, BullMQ, and Soroban RPC calls share a trace.
 */
export async function withWorkerSpan<T>(
  workerName: string,
  run: () => Promise<T>,
): Promise<T> {
  return workerTracer.startActiveSpan(
    `worker.${workerName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: { "worker.name": workerName },
    },
    async (span) => {
      try {
        const result = await run();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
